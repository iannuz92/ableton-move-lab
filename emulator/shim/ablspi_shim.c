#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/file.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#define SPI_DEVICE "/dev/ablspi0.0"
#define SPI_DUMMY_DEVICE "/emulator/spi/ablspi0.0"
#define SPI_MAP_SIZE 4096
#define SPI_CMD_TRANSFER 0x0a
#define SPI_CMD_SPEED 0x0b
#define SPI_RX_MIDI_OFFSET 0x800
#define SPI_RX_MIDI_SLOTS 31
#define SPI_RX_MIDI_SLOT_SIZE 8
#define USB_MIDI_PACKET_SIZE 4
#define SPI_RX_MIDI_SIZE (SPI_RX_MIDI_SLOTS * SPI_RX_MIDI_SLOT_SIZE)
#define SPI_RX_MIDI_INPUT_SIZE (SPI_RX_MIDI_SLOTS * USB_MIDI_PACKET_SIZE)

/*
 * Audio out: each 768-byte SPI frame carries 512 bytes of PCM at offset 0x100 =
 * 128 frames * 2 channels * 16-bit little-endian, 44100 Hz (verified by capture
 * analysis: that region has full per-byte variance and decodes to a smooth
 * waveform). Streamed to a capped file the Node server tails for live playback.
 */
#define SPI_AUDIO_OFFSET 0x100
#define SPI_AUDIO_SIZE   0x200
#define SPI_AUDIO_CAP    (64 * 1024 * 1024)
/* 1 s of stereo 16-bit @ 44.1k. Must stay >= the largest delivery burst from
 * the emulated firmware, otherwise audio_ring_push drops mid-stream samples and
 * the output distorts. Latency is bounded downstream, not by shrinking this. */
#define AUDIO_RING_SIZE  (44100 * 4)

struct packet_header {
    uint64_t sequence;
    uint64_t monotonic_ns;
    uint32_t length;
    uint32_t reserved;
};

static void *(*real_mmap_fn)(void *, size_t, int, int, int, off_t);
static int (*real_ioctl_fn)(int, unsigned long, ...);
static int (*real_open_fn)(const char *, int, ...);
static int (*real_open64_fn)(const char *, int, ...);
static int (*real_openat_fn)(int, const char *, int, ...);
static int (*real_openat64_fn)(int, const char *, int, ...);
static int (*real_close_fn)(int);
static long (*real_syscall_fn)(long, ...);
static pthread_mutex_t capture_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t fd_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned char *spi_map;
static size_t spi_map_length;
static int spi_fd = -1;
static uint64_t sequence;
static unsigned char previous_tx[SPI_MAP_SIZE];
static size_t previous_tx_length;
static unsigned char previous_rx[SPI_MAP_SIZE];
static size_t previous_rx_length;
static off_t midi_input_offset;
static unsigned int scripted_step;
static unsigned int script_debug_count;
static uintptr_t forced_display_connection;
static unsigned int forced_display_step;
static unsigned int forced_display_scan_throttle;
static long spi_transfer_delay_us = -1;
static unsigned char tracked_spi_fds[4096];

static int handle_spi_ioctl_request(int fd, unsigned long request, unsigned long argument);

static void ensure_open_symbols(void) {
    if (!real_open_fn) real_open_fn = dlsym(RTLD_NEXT, "open");
    if (!real_open64_fn) real_open64_fn = dlsym(RTLD_NEXT, "open64");
    if (!real_openat_fn) real_openat_fn = dlsym(RTLD_NEXT, "openat");
    if (!real_openat64_fn) real_openat64_fn = dlsym(RTLD_NEXT, "openat64");
}

static void track_spi_fd(int fd) {
    if (fd < 0 || fd >= (int)sizeof(tracked_spi_fds)) return;
    pthread_mutex_lock(&fd_lock);
    tracked_spi_fds[fd] = 1;
    pthread_mutex_unlock(&fd_lock);
}

static void untrack_spi_fd(int fd) {
    if (fd < 0 || fd >= (int)sizeof(tracked_spi_fds)) return;
    pthread_mutex_lock(&fd_lock);
    tracked_spi_fds[fd] = 0;
    if (spi_fd == fd) spi_fd = -1;
    pthread_mutex_unlock(&fd_lock);
}

static int fd_is_tracked_spi(int fd) {
    if (fd < 0 || fd >= (int)sizeof(tracked_spi_fds)) return 0;
    pthread_mutex_lock(&fd_lock);
    const int tracked = tracked_spi_fds[fd] != 0;
    pthread_mutex_unlock(&fd_lock);
    return tracked;
}

static int fd_is_spi(int fd) {
    if (fd_is_tracked_spi(fd)) {
        return 1;
    }

    char proc_path[64];
    char target[256];
    snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", fd);
    const ssize_t length = readlink(proc_path, target, sizeof(target) - 1);
    if (length < 0) {
        return 0;
    }
    target[length] = '\0';
    return strcmp(target, SPI_DEVICE) == 0;
}

static int spi_dummy_flags(int flags) {
    int dummy_flags = O_RDWR | O_CREAT;
    if (flags & O_CLOEXEC) dummy_flags |= O_CLOEXEC;
    if (flags & O_NONBLOCK) dummy_flags |= O_NONBLOCK;
    if (flags & O_NOCTTY) dummy_flags |= O_NOCTTY;
    return dummy_flags;
}

static int open_spi_dummy(int flags) {
    ensure_open_symbols();
    mkdir("/emulator", 0755);
    mkdir("/emulator/spi", 0755);
    int fd = real_open_fn(SPI_DUMMY_DEVICE, spi_dummy_flags(flags), 0666);
    if (fd >= 0) {
        track_spi_fd(fd);
    }
    return fd;
}

int open(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list arguments;
        va_start(arguments, flags);
        mode = (mode_t)va_arg(arguments, int);
        va_end(arguments);
    }

    if (path && strcmp(path, SPI_DEVICE) == 0) {
        return open_spi_dummy(flags);
    }

    ensure_open_symbols();
    if (flags & O_CREAT) return real_open_fn(path, flags, mode);
    return real_open_fn(path, flags);
}

int open64(const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list arguments;
        va_start(arguments, flags);
        mode = (mode_t)va_arg(arguments, int);
        va_end(arguments);
    }

    if (path && strcmp(path, SPI_DEVICE) == 0) {
        return open_spi_dummy(flags);
    }

    ensure_open_symbols();
    if (flags & O_CREAT) return real_open64_fn(path, flags, mode);
    return real_open64_fn(path, flags);
}

int __open_2(const char *path, int flags) {
    if (path && strcmp(path, SPI_DEVICE) == 0) {
        return open_spi_dummy(flags);
    }
    ensure_open_symbols();
    return real_open_fn(path, flags);
}

int __open64_2(const char *path, int flags) {
    if (path && strcmp(path, SPI_DEVICE) == 0) {
        return open_spi_dummy(flags);
    }
    ensure_open_symbols();
    return real_open64_fn(path, flags);
}

int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list arguments;
        va_start(arguments, flags);
        mode = (mode_t)va_arg(arguments, int);
        va_end(arguments);
    }

    if (path && strcmp(path, SPI_DEVICE) == 0) {
        return open_spi_dummy(flags);
    }

    ensure_open_symbols();
    if (flags & O_CREAT) return real_openat_fn(dirfd, path, flags, mode);
    return real_openat_fn(dirfd, path, flags);
}

int openat64(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list arguments;
        va_start(arguments, flags);
        mode = (mode_t)va_arg(arguments, int);
        va_end(arguments);
    }

    if (path && strcmp(path, SPI_DEVICE) == 0) {
        return open_spi_dummy(flags);
    }

    ensure_open_symbols();
    if (flags & O_CREAT) return real_openat64_fn(dirfd, path, flags, mode);
    return real_openat64_fn(dirfd, path, flags);
}

int __openat_2(int dirfd, const char *path, int flags) {
    if (path && strcmp(path, SPI_DEVICE) == 0) {
        return open_spi_dummy(flags);
    }
    ensure_open_symbols();
    return real_openat_fn(dirfd, path, flags);
}

int __openat64_2(int dirfd, const char *path, int flags) {
    if (path && strcmp(path, SPI_DEVICE) == 0) {
        return open_spi_dummy(flags);
    }
    ensure_open_symbols();
    return real_openat64_fn(dirfd, path, flags);
}

int close(int fd) {
    if (!real_close_fn) {
        real_close_fn = dlsym(RTLD_NEXT, "close");
    }
    untrack_spi_fd(fd);
    return real_close_fn(fd);
}

long syscall(long number, ...) {
    if (!real_syscall_fn) {
        real_syscall_fn = dlsym(RTLD_NEXT, "syscall");
    }

    va_list arguments;
    va_start(arguments, number);
    long a1 = va_arg(arguments, long);
    long a2 = va_arg(arguments, long);
    long a3 = va_arg(arguments, long);
    long a4 = va_arg(arguments, long);
    long a5 = va_arg(arguments, long);
    long a6 = va_arg(arguments, long);
    va_end(arguments);

#ifdef SYS_openat
    if (number == SYS_openat) {
        const char *path = (const char *)a2;
        if (path && strcmp(path, SPI_DEVICE) == 0) {
            return open_spi_dummy((int)a3);
        }
    }
#endif

#ifdef SYS_open
    if (number == SYS_open) {
        const char *path = (const char *)a1;
        if (path && strcmp(path, SPI_DEVICE) == 0) {
            return open_spi_dummy((int)a2);
        }
    }
#endif

#ifdef SYS_ioctl
    if (number == SYS_ioctl && fd_is_spi((int)a1)) {
        return handle_spi_ioctl_request((int)a1, (unsigned long)a2, (unsigned long)a3);
    }
#endif

    return real_syscall_fn(number, a1, a2, a3, a4, a5, a6);
}

static uint64_t monotonic_ns(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000000000ULL + (uint64_t)now.tv_nsec;
}

/*
 * Pace the SPI/XMOS transfer loop, which clocks the Move engine's audio
 * production (one 128-frame block per transfer).
 *
 * Legacy mode (MOVE_XMOS_TRANSFER_US > 0): sleep a fixed RELATIVE delay after
 * each transfer. Cadence = engine work time + delay; since the work time jitters
 * (~2.6-2.85 ms), the audio rate wanders by thousands of Hz and the shim must
 * decimate to 44100 -> aliasing ("Redux" sound).
 *
 * Lock mode (default, MOVE_XMOS_TRANSFER_US == 0/unset): pace to an ABSOLUTE
 * time grid of MOVE_XMOS_LOCK_US (default 2902 us = 128/44100 s). The transfer
 * waits until the next grid deadline, so the cadence is locked to 344.53/s =
 * 44100 Hz regardless of work-time jitter. Short overruns keep the absolute
 * grid and recover on the next transfers; only sustained stalls resync instead
 * of creating a long catch-up burst.
 */
static void pace_spi_transfer(void) {
    static int lock_us = -1;
    static uint64_t next_deadline_ns = 0;

    if (spi_transfer_delay_us < 0) {
        const char *configured = getenv("MOVE_XMOS_TRANSFER_US");
        spi_transfer_delay_us = configured ? strtol(configured, NULL, 10) : 0;
        if (spi_transfer_delay_us < 0) {
            spi_transfer_delay_us = 0;
        }
        const char *lock = getenv("MOVE_XMOS_LOCK_US");
        lock_us = lock ? (int)strtol(lock, NULL, 10) : 2902; /* 128/44100 s */
        if (lock_us < 1) lock_us = 2902;
    }

    if (spi_transfer_delay_us > 0) {
        struct timespec delay = {
            .tv_sec = spi_transfer_delay_us / 1000000,
            .tv_nsec = (spi_transfer_delay_us % 1000000) * 1000,
        };
        nanosleep(&delay, NULL);
        return;
    }

    /* Absolute-grid lock to a stable 44100 Hz audio cadence. */
    const uint64_t period_ns = (uint64_t)lock_us * 1000ULL;
    uint64_t now = monotonic_ns();
    if (next_deadline_ns == 0) {
        next_deadline_ns = now + period_ns;
        return;
    }
    if (now < next_deadline_ns) {
        const uint64_t remaining = next_deadline_ns - now;
        struct timespec ts = {
            .tv_sec = remaining / 1000000000ULL,
            .tv_nsec = remaining % 1000000000ULL,
        };
        nanosleep(&ts, NULL);
    }
    next_deadline_ns += period_ns;
    now = monotonic_ns();
    if (now > next_deadline_ns + period_ns * 4ULL) {
        next_deadline_ns = now + period_ns; /* sustained stall: resync */
    }
}

static void write_all(int fd, const void *data, size_t length) {
    const unsigned char *cursor = data;
    while (length > 0) {
        const ssize_t written = write(fd, cursor, length);
        if (written <= 0) {
            return;
        }
        cursor += written;
        length -= (size_t)written;
    }
}

static int packet_is_empty(const unsigned char *data, size_t length) {
    for (size_t index = 0; index < length; index += 1) {
        if (data[index] != 0) {
            return 0;
        }
    }
    return 1;
}

static int tx_packet_equal_for_capture(
    const unsigned char *left,
    const unsigned char *right,
    size_t length) {
    if (length <= SPI_AUDIO_OFFSET ||
        length < SPI_AUDIO_OFFSET + SPI_AUDIO_SIZE) {
        return memcmp(left, right, length) == 0;
    }

    if (memcmp(left, right, SPI_AUDIO_OFFSET) != 0) {
        return 0;
    }

    const size_t audio_end = SPI_AUDIO_OFFSET + SPI_AUDIO_SIZE;
    if (audio_end < length &&
        memcmp(left + audio_end, right + audio_end, length - audio_end) != 0) {
        return 0;
    }

    return 1;
}

/*
 * TX MIDI is a packed stream of 4-byte USB-MIDI packets at mmap + 0x000.
 * RX MIDI is asymmetric: SpiTransfer reads 31 fixed 8-byte slots starting at
 * mmap + 0x800 and stops at the first zero slot. The low four bytes hold the
 * USB-MIDI packet; the upper four bytes are timestamp/reserved data.
 */
static size_t write_rx_midi_packets_at(
    const unsigned char *packets, size_t length, size_t start_slot) {
    if (!spi_map || spi_map_length < SPI_RX_MIDI_OFFSET + SPI_RX_MIDI_SIZE) {
        return 0;
    }
    if (start_slot >= SPI_RX_MIDI_SLOTS) {
        return 0;
    }

    unsigned char *destination = spi_map + SPI_RX_MIDI_OFFSET;
    /*
     * Clear only the slots we own. When emit_xmos_reply has already written a
     * reply into the earlier slots on this same transfer, start_slot > 0 keeps
     * that reply intact while still appending user MIDI after it. This is what
     * lets the XMOS battery/devinfo responder and live GUI input coexist
     * instead of starving each other.
     */
    memset(destination + start_slot * SPI_RX_MIDI_SLOT_SIZE, 0,
           (SPI_RX_MIDI_SLOTS - start_slot) * SPI_RX_MIDI_SLOT_SIZE);

    size_t packet_count = length / USB_MIDI_PACKET_SIZE;
    if (packet_count > SPI_RX_MIDI_SLOTS - start_slot) {
        packet_count = SPI_RX_MIDI_SLOTS - start_slot;
    }
    for (size_t index = 0; index < packet_count; index += 1) {
        memcpy(
            destination + (start_slot + index) * SPI_RX_MIDI_SLOT_SIZE,
            packets + index * USB_MIDI_PACKET_SIZE,
            USB_MIDI_PACKET_SIZE);
    }
    return packet_count * USB_MIDI_PACKET_SIZE;
}

static size_t write_rx_midi_packets(const unsigned char *packets, size_t length) {
    return write_rx_midi_packets_at(packets, length, 0);
}

static void write_capture_files(const char *basename, const unsigned char *data, size_t length) {
    char path[128];
    snprintf(path, sizeof(path), "/emulator/spi/%s-packets.bin", basename);

    const struct packet_header header = {
        .sequence = ++sequence,
        .monotonic_ns = monotonic_ns(),
        .length = (uint32_t)length,
        .reserved = (uint32_t)getpid(),
    };

    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd >= 0) {
        if (flock(fd, LOCK_EX) == 0) {
            write_all(fd, &header, sizeof(header));
            write_all(fd, data, length);
            flock(fd, LOCK_UN);
        }
        close(fd);
    }

    const char *latest = getenv("MOVE_SPI_LATEST_CAPTURE");
    if (!latest || strcmp(latest, "1") != 0) {
        return;
    }

    snprintf(path, sizeof(path), "/emulator/spi/%s-latest.bin", basename);
    fd = open(path, O_WRONLY | O_CREAT, 0644);
    if (fd >= 0) {
        if (flock(fd, LOCK_EX) == 0) {
            ftruncate(fd, 0);
            lseek(fd, 0, SEEK_SET);
            write_all(fd, data, length);
            flock(fd, LOCK_UN);
        }
        close(fd);
    }

    snprintf(path, sizeof(path), "/emulator/spi/%s-latest.meta", basename);
    fd = open(path, O_WRONLY | O_CREAT, 0644);
    if (fd >= 0) {
        char metadata[128];
        const int metadata_length = snprintf(
            metadata,
            sizeof(metadata),
            "sequence=%llu\nlength=%zu\nempty=%d\n",
            (unsigned long long)sequence,
            length,
            packet_is_empty(data, length));
        if (flock(fd, LOCK_EX) == 0) {
            ftruncate(fd, 0);
            lseek(fd, 0, SEEK_SET);
            write_all(fd, metadata, (size_t)metadata_length);
            flock(fd, LOCK_UN);
        }
        close(fd);
    }
}

/*
 * Append the PCM region of the current TX frame to /emulator/spi/audio.raw so
 * the Node server can stream it for live playback. Gated by MOVE_AUDIO_STREAM=1.
 * The file wraps at SPI_AUDIO_CAP (the server detects the shrink and reseeks).
 */
static int audio_fd = -1;
static long audio_written;
static uint64_t audio_started_ns;
static pthread_mutex_t audio_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t audio_cond = PTHREAD_COND_INITIALIZER;
static pthread_t audio_thread;
static int audio_thread_started;
static unsigned char audio_ring[AUDIO_RING_SIZE];
static size_t audio_ring_read;
static size_t audio_ring_write;
static size_t audio_ring_used;

static void pace_audio_stream(void) {
    const uint64_t bytes_per_second = 44100ULL * 4ULL;
    const uint64_t target_elapsed_ns =
        ((uint64_t)audio_written * 1000000000ULL) / bytes_per_second;
    const uint64_t target_ns = audio_started_ns + target_elapsed_ns;

    for (;;) {
        const uint64_t now = monotonic_ns();
        if (now >= target_ns) return;
        const uint64_t remaining_ns = target_ns - now;
        struct timespec delay = {
            .tv_sec = remaining_ns / 1000000000ULL,
            .tv_nsec = remaining_ns % 1000000000ULL,
        };
        nanosleep(&delay, NULL);
    }
}

static void audio_ring_drop(size_t count) {
    if (count > audio_ring_used) count = audio_ring_used;
    audio_ring_read = (audio_ring_read + count) % AUDIO_RING_SIZE;
    audio_ring_used -= count;
}

static void audio_ring_push(const unsigned char *data, size_t length) {
    if (length >= AUDIO_RING_SIZE) {
        data += length - SPI_AUDIO_SIZE;
        length = SPI_AUDIO_SIZE;
        audio_ring_read = 0;
        audio_ring_write = 0;
        audio_ring_used = 0;
    }
    if (audio_ring_used + length > AUDIO_RING_SIZE) {
        audio_ring_drop(audio_ring_used + length - AUDIO_RING_SIZE);
    }
    for (size_t index = 0; index < length; index += 1) {
        audio_ring[audio_ring_write] = data[index];
        audio_ring_write = (audio_ring_write + 1) % AUDIO_RING_SIZE;
    }
    audio_ring_used += length;
}

static size_t audio_ring_pop(unsigned char *target, size_t length) {
    if (length > audio_ring_used) length = audio_ring_used;
    for (size_t index = 0; index < length; index += 1) {
        target[index] = audio_ring[audio_ring_read];
        audio_ring_read = (audio_ring_read + 1) % AUDIO_RING_SIZE;
    }
    audio_ring_used -= length;
    return length;
}

/*
 * Declick the seam between consecutive 512-byte audio blocks. The emulated Move
 * audio engine occasionally emits a block that does not continue smoothly from
 * the previous one (it runs without hard real-time scheduling), producing a
 * step discontinuity heard as crackle. We remove the step at the boundary with
 * a short decaying correction: out[k] = s[k] - step * (FADE-k)/FADE, so out[0]
 * lands exactly on the previous sample and the original waveform is restored by
 * frame FADE. Gated by a local-roughness guard so loud high-frequency content
 * (which legitimately has large sample deltas) is left untouched.
 */
#define DECLICK_FADE 16   /* frames over which the step correction fades out */
#define DECLICK_ABS  500  /* minimum seam jump (per channel) to act on */
#define DECLICK_MULT 3    /* and the jump must exceed this * local avg |delta| */

static int audio_declick_enabled(void) {
    const char *e = getenv("MOVE_AUDIO_DECLICK");
    return !e || strcmp(e, "0") != 0; /* default on */
}

static int16_t declick_clamp(int v) {
    if (v > 32767) return 32767;
    if (v < -32768) return -32768;
    return (int16_t)v;
}

static int declick_have_prev;
static int16_t declick_prev_l, declick_prev_r;
static int declick_davg_l = 1, declick_davg_r = 1;

static void declick_block(unsigned char *chunk) {
    int16_t *s = (int16_t *)chunk;
    const int frames = SPI_AUDIO_SIZE / 4; /* 128 stereo frames */
    if (declick_have_prev) {
        const int dl = (int)s[0] - (int)declick_prev_l;
        const int dr = (int)s[1] - (int)declick_prev_r;
        if (abs(dl) > DECLICK_ABS && abs(dl) > DECLICK_MULT * declick_davg_l) {
            for (int k = 0; k < DECLICK_FADE && k < frames; k += 1) {
                const int corr = dl * (DECLICK_FADE - k) / DECLICK_FADE;
                s[k * 2] = declick_clamp((int)s[k * 2] - corr);
            }
        }
        if (abs(dr) > DECLICK_ABS && abs(dr) > DECLICK_MULT * declick_davg_r) {
            for (int k = 0; k < DECLICK_FADE && k < frames; k += 1) {
                const int corr = dr * (DECLICK_FADE - k) / DECLICK_FADE;
                s[k * 2 + 1] = declick_clamp((int)s[k * 2 + 1] - corr);
            }
        }
    }
    /* Local roughness from the tail of this block, used to guard the next seam. */
    int sl = 0, sr = 0, cnt = 0;
    for (int k = frames - 5; k < frames - 1; k += 1) {
        if (k < 0) continue;
        sl += abs((int)s[(k + 1) * 2] - (int)s[k * 2]);
        sr += abs((int)s[(k + 1) * 2 + 1] - (int)s[k * 2 + 1]);
        cnt += 1;
    }
    if (cnt > 0) {
        declick_davg_l = sl / cnt + 1;
        declick_davg_r = sr / cnt + 1;
    }
    declick_prev_l = s[(frames - 1) * 2];
    declick_prev_r = s[(frames - 1) * 2 + 1];
    declick_have_prev = 1;
}

static void *audio_writer_main(void *unused) {
    (void)unused;
    unsigned char chunk[SPI_AUDIO_SIZE];
    for (;;) {
        pthread_mutex_lock(&audio_lock);
        while (audio_ring_used < SPI_AUDIO_SIZE) {
            pthread_cond_wait(&audio_cond, &audio_lock);
        }
        audio_ring_pop(chunk, SPI_AUDIO_SIZE);
        pthread_mutex_unlock(&audio_lock);

        if (audio_declick_enabled()) declick_block(chunk);

        if (audio_fd < 0) {
            audio_fd = open("/emulator/spi/audio.raw", O_WRONLY | O_CREAT | O_TRUNC, 0644);
            if (audio_fd < 0) continue;
            audio_written = 0;
            audio_started_ns = monotonic_ns();
        }
        if (audio_written >= SPI_AUDIO_CAP) {
            if (ftruncate(audio_fd, 0) == 0) {
                lseek(audio_fd, 0, SEEK_SET);
                audio_written = 0;
                audio_started_ns = monotonic_ns();
            }
        }
        write_all(audio_fd, chunk, SPI_AUDIO_SIZE);
        audio_written += SPI_AUDIO_SIZE;
        pace_audio_stream();
    }
    return NULL;
}

static void write_audio_frame(size_t length) {
    const char *en = getenv("MOVE_AUDIO_STREAM");
    if (!en || strcmp(en, "1") != 0) return;
    if (!spi_map || length < SPI_AUDIO_OFFSET + SPI_AUDIO_SIZE) return;
    if (spi_map_length < SPI_AUDIO_OFFSET + SPI_AUDIO_SIZE) return;

    pthread_mutex_lock(&audio_lock);
    if (!audio_thread_started) {
        audio_thread_started = pthread_create(&audio_thread, NULL, audio_writer_main, NULL) == 0;
        if (audio_thread_started) pthread_detach(audio_thread);
    }
    audio_ring_push(spi_map + SPI_AUDIO_OFFSET, SPI_AUDIO_SIZE);
    pthread_cond_signal(&audio_cond);
    pthread_mutex_unlock(&audio_lock);
}

static void capture_tx_packet(size_t length) {
    if (!spi_map) {
        return;
    }
    if (length > SPI_MAP_SIZE) {
        length = SPI_MAP_SIZE;
    }

    pthread_mutex_lock(&capture_lock);
    if (length == previous_rx_length && memcmp(previous_rx, spi_map, length) == 0) {
        pthread_mutex_unlock(&capture_lock);
        return;
    }
    if (length == previous_tx_length &&
        tx_packet_equal_for_capture(previous_tx, spi_map, length)) {
        memcpy(previous_tx, spi_map, length);
        pthread_mutex_unlock(&capture_lock);
        return;
    }

    memcpy(previous_tx, spi_map, length);
    previous_tx_length = length;
    write_capture_files("tx", spi_map, length);

    const char *legacy = getenv("MOVE_LEGACY_SPI_CAPTURE");
    if (legacy && strcmp(legacy, "1") == 0) {
        /*
         * Backward-compatible filenames used by the Node UI before TX/RX were
         * split. Disabled by default because these synchronous writes run
         * inside every SPI transfer and directly steal audio clock budget.
         */
        int fd = open("/emulator/spi/packets.bin", O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (fd >= 0) {
            const struct packet_header header = {
                .sequence = sequence,
                .monotonic_ns = monotonic_ns(),
                .length = (uint32_t)length,
                .reserved = (uint32_t)getpid(),
            };
            if (flock(fd, LOCK_EX) == 0) {
                write_all(fd, &header, sizeof(header));
                write_all(fd, spi_map, length);
                flock(fd, LOCK_UN);
            }
            close(fd);
        }
    }
    pthread_mutex_unlock(&capture_lock);
}

static void remember_rx(size_t length) {
    if (!spi_map) {
        return;
    }
    if (length > SPI_MAP_SIZE) {
        length = SPI_MAP_SIZE;
    }
    memcpy(previous_rx, spi_map, length);
    previous_rx_length = length;
    const char *capture_rx = getenv("MOVE_XMOS_CAPTURE_RX");
    if (!capture_rx || strcmp(capture_rx, "0") != 0) {
        write_capture_files("rx", spi_map, length);
    }
}

static size_t fill_scripted_xmos(unsigned char *destination, size_t length) {
    const char *mode = getenv("MOVE_XMOS_SCRIPT");
    if (mode && strcmp(mode, "off") == 0) {
        return 0;
    }
    if (mode && strncmp(mode, "battery-", 8) == 0) {
        if (scripted_step != 0 || length < 16) {
            return 0;
        }
        const unsigned char state =
            strcmp(mode, "battery-full") == 0 ? 0x02 : 0x00;
        const unsigned char charge =
            strcmp(mode, "battery-full") == 0 ? 100 : 0;
        const unsigned char message[] = {
            0x04,0xf0,0x00,0x21,
            0x04,0x1d,0x01,0x01,
            0x04,0x3a,state,charge,
            0x06,0x00,0xf7,0x00
        };
        memcpy(destination, message, sizeof(message));
        scripted_step = 1;
        return sizeof(message);
    }

    /*
     * The observed SPI payload is USB-MIDI packets. The real XMOS appears to
     * drive display transfers by sending state / display-chunk requests back
     * to the CM. This rotating script gives the Move process the handshake
     * shapes we have observed plus candidate display chunk requests.
     */
    const size_t script_count = 17;
    size_t written = 0;

    /*
     * Send a small burst per SPI transfer. This keeps the app responsive and
     * makes captures easier to correlate transfer-by-transfer.
     */
    for (size_t index = 0; index < 4 && written + 4 <= length; index += 1) {
        unsigned char a = 0;
        unsigned char b = 0;
        unsigned char c = 0;
        unsigned char d = 0;
        switch (scripted_step % script_count) {
            case 0: a = 0xfb; b = 0xb0; c = 0x00; d = 0x02; break;
            case 1: a = 0xfb; b = 0xb0; c = 0x01; d = 0x40; break;
            case 2: a = 0x0f; b = 0xff; c = 0x00; d = 0x00; break;
            case 3: a = 0x04; b = 0xf0; c = 0x00; d = 0x21; break;
            case 4: a = 0x04; b = 0x1d; c = 0x01; d = 0x01; break;
            case 5: a = 0x04; b = 0x3a; c = 0x00; d = 0x00; break;
            case 6: a = 0x06; b = 0x00; c = 0xf7; d = 0x00; break;
            case 7: a = 0xfb; b = 0xb0; c = 0x01; d = 0x7f; break;
            case 8: a = 0xfb; b = 0xb0; c = 0x02; d = 0x7f; break;
            case 9: a = 0xfb; b = 0xb0; c = 0x03; d = 0x7f; break;
            case 10: a = 0xfb; b = 0xb0; c = 0x04; d = 0x7f; break;
            case 11: a = 0xfb; b = 0xb0; c = 0x05; d = 0x7f; break;
            case 12: a = 0xfb; b = 0xb0; c = 0x06; d = 0x7f; break;
            case 13: a = 0x04; b = 0xf0; c = 0x00; d = 0x21; break;
            case 14: a = 0x04; b = 0x1d; c = 0x01; d = 0x01; break;
            case 15: a = 0x04; b = 0x3a; c = 0x40; d = 0x02; break;
            default: a = 0x06; b = 0x01; c = 0xf7; d = 0x00; break;
        }
        destination[written] = a;
        destination[written + 1] = b;
        destination[written + 2] = c;
        destination[written + 3] = d;
        scripted_step += 1;
        written += 4;
    }
    return written;
}

static void log_script_decision(const char *reason, ssize_t bytes_read, size_t bytes_written, const unsigned char *snapshot) {
    /*
     * Callers only pass interesting injection decisions here (real reads and
     * error/edge branches), not the per-transfer "no input" case, so this stays
     * low volume without an artificial cap. A previous hard cap of 64 lines
     * silently turned this into a permanent no-op after boot, which made a
     * working injection path look identical to a stalled one.
     */
    script_debug_count += 1;

    int fd = open("/emulator/spi/script.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) {
        return;
    }

    char line[160];
    const char *mode = getenv("MOVE_XMOS_SCRIPT");
    const int line_length = snprintf(
        line,
        sizeof(line),
        "reason=%s mode=%s bytes_read=%zd bytes_written=%zu midi_offset=%lld\n",
        reason,
        mode ? mode : "(null)",
        bytes_read,
        bytes_written,
        (long long)midi_input_offset);
    write_all(fd, line, (size_t)line_length);
    if (snapshot) {
        const int hex_length = snprintf(
            line,
            sizeof(line),
            "head=%02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x\n",
            snapshot[0], snapshot[1], snapshot[2], snapshot[3],
            snapshot[4], snapshot[5], snapshot[6], snapshot[7],
            snapshot[8], snapshot[9], snapshot[10], snapshot[11],
            snapshot[12], snapshot[13], snapshot[14], snapshot[15]);
        write_all(fd, line, (size_t)hex_length);
    }
    close(fd);
}

static void log_force_display(const char *message, uintptr_t address, unsigned int request) {
    int fd = open("/emulator/spi/force-display.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) {
        return;
    }
    char line[160];
    const int line_length = snprintf(
        line,
        sizeof(line),
        "%s address=0x%llx request=%u\n",
        message,
        (unsigned long long)address,
        request);
    write_all(fd, line, (size_t)line_length);
    close(fd);
}

static int looks_like_connection(uintptr_t base, uintptr_t region_end) {
    if (base + 0x900 >= region_end) {
        return 0;
    }

    const uint32_t display_marker = *(const uint32_t *)(base + 0x1e0 + 8);
    if (display_marker != 1 && display_marker != 2) {
        return 0;
    }

    const uintptr_t display_begin = *(const uintptr_t *)(base + 0x1e0 + 0x70);
    const uintptr_t display_end = *(const uintptr_t *)(base + 0x1e0 + 0x78);
    const uintptr_t display_capacity = *(const uintptr_t *)(base + 0x1e0 + 0x80);
    if (!display_begin || display_end < display_begin || display_capacity < display_end) {
        return 0;
    }
    if (display_end - display_begin != 0x400) {
        return 0;
    }

    const uint32_t transfer_state = *(const uint32_t *)(base + 0x1e0 + 0xc0);
    const uint32_t chunk_cursor = *(const uint32_t *)(base + 0x1e0 + 0xc4);
    return transfer_state <= 6 && chunk_cursor <= 6;
}

static uintptr_t find_display_connection(void) {
    FILE *maps = fopen("/proc/self/maps", "r");
    if (!maps) {
        return 0;
    }

    char line[512];
    while (fgets(line, sizeof(line), maps)) {
        unsigned long long start = 0;
        unsigned long long end = 0;
        char perms[5] = {0};
        if (sscanf(line, "%llx-%llx %4s", &start, &end, perms) != 3) {
            continue;
        }
        if (perms[0] != 'r' || perms[1] != 'w') {
            continue;
        }
        if (end <= start || end - start > 256ULL * 1024ULL * 1024ULL) {
            continue;
        }

        uintptr_t cursor = (uintptr_t)start;
        const uintptr_t limit = (uintptr_t)end;
        for (; cursor + 0x900 < limit; cursor += 8) {
            if (looks_like_connection(cursor, limit)) {
                fclose(maps);
                return cursor;
            }
        }
    }

    fclose(maps);
    return 0;
}

static void force_next_display_request(void) {
    const char *mode = getenv("MOVE_XMOS_FORCE_DISPLAY");
    if (!mode || strcmp(mode, "1") != 0) {
        return;
    }

    if (!forced_display_connection) {
        forced_display_scan_throttle += 1;
        if (forced_display_scan_throttle % 64 != 1) {
            return;
        }
        forced_display_connection = find_display_connection();
        if (forced_display_connection) {
            log_force_display("found", forced_display_connection, 0);
        }
    }
    if (!forced_display_connection) {
        return;
    }

    const unsigned char running =
        *(const unsigned char *)(forced_display_connection + 0x1d8);
    if (running == 0) {
        if (spi_map && spi_map_length >= 0x8fc) {
            *(uint32_t *)(spi_map + 0x8f8) = 0;
        }
        *(uint32_t *)(forced_display_connection + 0x2a0) = 0;
        *(uint32_t *)(forced_display_connection + 0x2a4) = 0;
        return;
    }

    const unsigned int request = (forced_display_step % 6U) + 1U;
    if (request == 1) {
        *(uint32_t *)(forced_display_connection + 0x1e0 + 0xc0) = 2;
    }
    if (spi_map && spi_map_length >= 0x8fc) {
        *(uint32_t *)(spi_map + 0x8f8) = request;
    }
    forced_display_step += 1;

    if (forced_display_step <= 12) {
        log_force_display("request", forced_display_connection, request);
    }
}

/*
 * Full-payload hex logger for the first transfers, used to reverse-engineer the
 * XMOS SysEx handshake (device-info query/response). No dedup, no throttle.
 * Gated by MOVE_XMOS_HANDSHAKE_LOG=1.
 */
static unsigned int handshake_log_count;

static void log_handshake_hex(const char *dir, const unsigned char *buf, size_t length) {
    const char *en = getenv("MOVE_XMOS_HANDSHAKE_LOG");
    if (!en || strcmp(en, "1") != 0) return;
    if (handshake_log_count >= 200) return;
    int fd = open("/emulator/spi/handshake.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) return;
    /* Only log non-empty payloads to skip idle polling noise. */
    size_t show = length;
    if (show > 64) show = 64;
    if (!packet_is_empty(buf, show)) {
        char line[512];
        int n = snprintf(line, sizeof(line), "%s seq=%llu len=%zu: ",
                         dir, (unsigned long long)sequence, length);
        for (size_t i = 0; i < show && n < (int)sizeof(line) - 4; i += 1)
            n += snprintf(line + n, sizeof(line) - n, "%02x ", buf[i]);
        n += snprintf(line + n, sizeof(line) - n, "\n");
        write_all(fd, line, (size_t)n);
        handshake_log_count += 1;
    }
    close(fd);
}

static void log_handshake_tx(size_t length) {
    if (!spi_map) return;
    if (length > SPI_MAP_SIZE) length = SPI_MAP_SIZE;
    log_handshake_hex("TX", spi_map, length);
}

static void log_handshake_rx(size_t length) {
    if (!spi_map) return;
    if (length > SPI_MAP_SIZE) length = SPI_MAP_SIZE;
    log_handshake_hex("RX", spi_map, length);
}

/* Free-form debug trace for the XMOS handshake, gated by MOVE_XMOS_DBG=1. */
static unsigned int xmos_dbg_count;
static void xmos_dbg(const char *fmt, ...) {
    const char *en = getenv("MOVE_XMOS_DBG");
    if (!en || strcmp(en, "1") != 0) return;
    if (xmos_dbg_count >= 2000) return;
    int fd = open("/emulator/spi/xmos-dbg.log", O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) return;
    char line[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n > 0) { write_all(fd, line, (size_t)n < sizeof(line) ? (size_t)n : sizeof(line)); xmos_dbg_count += 1; }
    close(fd);
}

/* Dump the RX MIDI slot region (mmap+0x800) as a compact hex string. */
static void xmos_dbg_rx_region(const char *tag) {
    const char *en = getenv("MOVE_XMOS_DBG");
    if (!en || strcmp(en, "1") != 0) return;
    if (!spi_map || spi_map_length < SPI_RX_MIDI_OFFSET + SPI_RX_MIDI_SIZE) return;
    const unsigned char *r = spi_map + SPI_RX_MIDI_OFFSET;
    char line[800];
    int n = snprintf(line, sizeof(line), "%s rx@0x800: ", tag);
    for (size_t i = 0; i < 64 && n < (int)sizeof(line) - 4; i += 1)
        n += snprintf(line + n, sizeof(line) - n, "%02x ", r[i]);
    xmos_dbg("%s\n", line);
}

/*
 * XMOS device-info responder.
 *
 * The Move binaries probe the XMOS over SPI with two SysEx queries observed in
 * the captured TX:
 *   1. MIDI Universal Identity Request:  F0 7E 01 06 01 F7
 *   2. Ableton device-info query:        F0 00 21 1D 01 01 42 00 F7
 * Without replies the firmware updater logs "Can't obtain XMOS device info" and
 * aborts. We synthesize plausible SysEx replies and emit them as RX.
 * Gated by MOVE_XMOS_DEVINFO=1.
 */
static unsigned int xmos_reply_pending; /* reply armed by the current TX query */
/* Last encoded RX block, retained for a delayed reply if configured. */
static unsigned char xmos_last_reply[SPI_RX_MIDI_INPUT_SIZE];
static size_t xmos_last_rn;
/* Transfers to stay silent after a query before replying (mimics XMOS latency). */
static unsigned int xmos_reply_delay;

/* Encode a raw SysEx byte run (F0..F7) into USB-MIDI 4-byte packets, cable 0. */
static size_t encode_sysex(unsigned char *dst, size_t cap,
                           const unsigned char *sx, size_t n) {
    size_t out = 0, i = 0;
    while (i < n && out + 4 <= cap) {
        size_t remain = n - i;
        if (remain > 3) {
            dst[out] = 0x04;
            dst[out+1] = sx[i]; dst[out+2] = sx[i+1]; dst[out+3] = sx[i+2];
            i += 3;
        } else if (remain == 3) {
            dst[out] = 0x07;
            dst[out+1] = sx[i]; dst[out+2] = sx[i+1]; dst[out+3] = sx[i+2];
            i += 3;
        } else if (remain == 2) {
            dst[out] = 0x06;
            dst[out+1] = sx[i]; dst[out+2] = sx[i+1]; dst[out+3] = 0;
            i += 2;
        } else {
            dst[out] = 0x05;
            dst[out+1] = sx[i]; dst[out+2] = 0; dst[out+3] = 0;
            i += 1;
        }
        out += 4;
    }
    return out;
}

static int mem_contains(const unsigned char *hay, size_t hlen,
                        const unsigned char *needle, size_t nlen) {
    if (nlen == 0 || hlen < nlen) return 0;
    for (size_t i = 0; i + nlen <= hlen; i += 1)
        if (memcmp(hay + i, needle, nlen) == 0) return 1;
    return 0;
}

/* If the captured TX (still in spi_map) holds an XMOS probe, arm replies. */
static void detect_xmos_query(size_t length) {
    const unsigned char id_req[]  = {0xf0, 0x7e};            /* identity request */
    const unsigned char abl_req[] = {0x00, 0x21, 0x04, 0x1d};/* F0 00 21 / 1D usb-midi run */
    /*
     * RX starts at 0x800 in the shared mmap. Searching the complete transfer
     * sees our own previous reply and re-arms the responder forever.
     */
    const size_t tx_length =
        length < SPI_RX_MIDI_OFFSET ? length : SPI_RX_MIDI_OFFSET;
    int hit_id  = mem_contains(spi_map, tx_length, id_req, sizeof(id_req));
    int hit_abl = mem_contains(spi_map, tx_length, abl_req, sizeof(abl_req));
    if (hit_id || hit_abl) {
        xmos_reply_pending = 1;
        xmos_reply_delay = 0;    /* same-transfer reply works for control-mode */
        xmos_dbg("detect: ARM len=%zu id=%d abl=%d pending=%u\n",
                 length, hit_id, hit_abl, xmos_reply_pending);
    }
}

/*
 * Reassemble the raw SysEx byte stream from the USB-MIDI TX packets in
 * spi_map+0. Each 4-byte packet's low CIN nibble gives the data length.
 */
static size_t reassemble_tx_sysex(unsigned char *out, size_t cap, size_t length) {
    size_t out_n = 0;
    size_t n = length > SPI_MAP_SIZE ? SPI_MAP_SIZE : length;
    if (n > SPI_RX_MIDI_OFFSET) {
        n = SPI_RX_MIDI_OFFSET;
    }
    for (size_t i = 0; i + 4 <= n; i += 4) {
        unsigned int cin = spi_map[i] & 0x0fu;
        int datalen;
        switch (cin) {
            case 0x4: case 0x7: datalen = 3; break;
            case 0x6:           datalen = 2; break;
            case 0x5:           datalen = 1; break;
            default:            datalen = 0; break;
        }
        for (int k = 0; k < datalen && out_n < cap; k += 1)
            out[out_n++] = spi_map[i + 1 + (size_t)k];
    }
    return out_n;
}

/* Find subsequence in buf; return index of byte AFTER the match, or -1. */
static long find_after(const unsigned char *buf, size_t n,
                       const unsigned char *pat, size_t plen) {
    if (plen == 0 || n < plen) return -1;
    for (size_t i = 0; i + plen <= n; i += 1)
        if (memcmp(buf + i, pat, plen) == 0) return (long)(i + plen);
    return -1;
}

/*
 * Contextual XMOS responder. Reassembles the current TX SysEx and replies to
 * the command actually asked:
 *   - 0x46 (get control mode) <mode>  -> F0 00 21 1D 01 01 47 <mode> F7
 *   - 0x42 (get device info)          -> device-info reply (format provisional)
 *   - F0 7E .. (identity request)     -> identity reply
 * Reply format reversed from MoveXmosCli fcn.000464f8 / MoveFirmwareAutoUpdater.
 */
static int emit_xmos_reply(size_t length) {
    const char *en = getenv("MOVE_XMOS_DEVINFO");
    if (!en || strcmp(en, "1") != 0) return 0;
    if (xmos_reply_pending == 0) return 0;

    unsigned char tx[256];
    size_t txn = reassemble_tx_sysex(tx, sizeof(tx), length);

    /* Ableton command prefix: F0 00 21 1D 01 01 <cmd> */
    static const unsigned char abl_prefix[] = {0xf0, 0x00, 0x21, 0x1d, 0x01, 0x01};
    static const unsigned char id_prefix[]  = {0xf0, 0x7e};

    /*
     * Build the RX packet block. The updater sends the Identity Request and the
     * device-info query together in one transfer, and expects BOTH replies, so
     * we accumulate every applicable reply into the same RX block.
     */
    unsigned char packets[SPI_RX_MIDI_INPUT_SIZE] = {0};
    size_t out = 0;
    const char *kind = "none";

    int has_id = find_after(tx, txn, id_prefix, sizeof(id_prefix)) >= 0;
    long ci = find_after(tx, txn, abl_prefix, sizeof(abl_prefix));

    const char *identity_mode = getenv("MOVE_XMOS_IDENTITY_REPLY");
    const int send_identity = !identity_mode || strcmp(identity_mode, "0") != 0;
    if (has_id && send_identity) {
        static const unsigned char idr[] = {
            0xf0,0x7e,0x01,0x06,0x02,0x00,0x21,0x1d,
            0x06,0x00,0x01,0x00,
            0x7f,0x7f,0x7f,0x7f,0x00,0x00,0x00,0x00,0x00,0x00,
            0x01,0x0d,0x00,
            0xf7};
        out += encode_sysex(packets + out, sizeof(packets) - out, idr, sizeof(idr));
        kind = "identity";
    }
    if (ci >= 0 && (size_t)ci < txn) {
        unsigned char cmd = tx[ci];
        if (cmd == 0x46) {
            unsigned char mode = ((size_t)ci + 1 < txn) ? tx[ci + 1] : 0x01;
            const unsigned char r[] = {0xf0,0x00,0x21,0x1d,0x01,0x01,0x47,mode,0xf7};
            out += encode_sysex(packets + out, sizeof(packets) - out, r, sizeof(r));
            kind = "ctrlmode-47";
        } else if (cmd == 0x42) {
            /*
             * Device-info reply, 25 bytes, reversed from
             * MoveFirmwareAutoUpdater fcn.0013a968: len==25, byte[2..6]=21 1D 01
             * 01 42, last=F7; version fields at idx 10,12,15,17,20,22 (0..127),
             * flags at 11,13,16,18,21,23 (0/1). Versions from on-disk firmware
             * (XMOS 1.0.80, PMC 1.13, MHC 1.6).
             */
            const unsigned char r[] = {
                0xf0,0x00,0x21,0x1d,0x01,0x01,0x42,
                0x00,0x00,0x00,
                0x7f,0x01, 0x7f,0x01, 0x00,
                0x7f,0x01, 0x7f,0x01, 0x00,
                0x7f,0x01, 0x7f,0x01,
                0xf7
            };
            out += encode_sysex(packets + out, sizeof(packets) - out, r, sizeof(r));
            kind = "devinfo-42";
        }
    }

    if (out == 0) {
        /*
         * No fresh query in this transfer. The device replies a few transfers
         * AFTER the query (the app sends once, then polls), so re-emit the last
         * built RX block during the pending window. This is what lets the
         * device-info poll loop actually read the response.
         */
        if (xmos_last_rn == 0) {
            xmos_dbg("emit: no-match txn=%zu (no stored reply)\n", txn);
            return 0;
        }
        memcpy(packets, xmos_last_reply, xmos_last_rn);
        out = xmos_last_rn;
        kind = "repeat";
    } else {
        memcpy(xmos_last_reply, packets, out);
        xmos_last_rn = out;
    }

    /* Mimic XMOS latency: stay silent for a few transfers after the query so the
     * app reads the response on a later poll, not the same full-duplex frame. */
    if (xmos_reply_delay > 0) {
        xmos_reply_delay -= 1;
        xmos_dbg("emit: delay (%u left), RX left empty\n", xmos_reply_delay);
        return 0;
    }

    write_rx_midi_packets(packets, out);
    xmos_reply_pending -= 1;
    remember_rx(length);
    xmos_dbg("emit: FIRED kind=%s out=%zu pending_left=%u\n",
             kind, out, xmos_reply_pending);
    xmos_dbg_rx_region("emit");
    /*
     * Return the number of RX bytes written so the caller can append user MIDI
     * into the remaining slots on this same transfer (coexistence). Non-zero
     * still reads as "reply fired" for any truthiness checks.
     */
    return out;
}

/*
 * Inject queued GUI MIDI from /emulator/input/midi.bin into the RX slots.
 *
 * reserved_bytes is how many RX bytes emit_xmos_reply already wrote at the
 * start of the region on this same transfer (0 when no reply fired). User MIDI
 * is appended into the slots after it so the XMOS responder never starves live
 * input. The scripted-XMOS fallback paths only run when no reply was emitted
 * (reserved_bytes == 0); when a reply is present we must not overwrite it.
 */
static void inject_midi(size_t length, size_t reserved_bytes) {
    if (!spi_map) {
        return;
    }
    const size_t start_slot = reserved_bytes / USB_MIDI_PACKET_SIZE;
    unsigned char packets[SPI_RX_MIDI_INPUT_SIZE] = {0};
    if (start_slot == 0) {
        /* No XMOS reply this transfer: clear the whole RX region first. */
        write_rx_midi_packets(packets, 0);
    }

    const int fd = open("/emulator/input/midi.bin", O_RDONLY);
    if (fd < 0) {
        if (start_slot == 0) {
            const size_t bytes_written = fill_scripted_xmos(packets, sizeof(packets));
            write_rx_midi_packets(packets, bytes_written);
            log_script_decision("no-midi-file", -1, bytes_written, packets);
        }
        remember_rx(length);
        return;
    }

    struct stat midi_stat;
    if (fstat(fd, &midi_stat) == 0) {
        if (midi_input_offset > midi_stat.st_size) {
            /*
             * The input file was truncated or recreated (GUI "reset queue", a
             * new session, or the start script clearing midi.bin). Our
             * persistent read offset now points past the new EOF, so every
             * subsequent event would be silently dropped as "midi-eof" forever
             * and no GUI input would ever reach the engine. Rewind to the
             * start, mirroring how server.mjs rewinds its audio/LED tail
             * offsets when the underlying file shrinks.
             */
            midi_input_offset = 0;
        }
        if (midi_input_offset >= midi_stat.st_size) {
            /* No new input this transfer (the common case): keep the scripted
             * XMOS fallback running when no reply fired, but do not log — it
             * would otherwise spam every transfer. */
            if (start_slot == 0) {
                const size_t bytes_written = fill_scripted_xmos(packets, sizeof(packets));
                write_rx_midi_packets(packets, bytes_written);
            }
            close(fd);
            remember_rx(length);
            return;
        }
    }

    /* Only read as many packets as fit in the slots left after any XMOS reply. */
    size_t capacity = (SPI_RX_MIDI_SLOTS - start_slot) * USB_MIDI_PACKET_SIZE;
    if (capacity > sizeof(packets)) {
        capacity = sizeof(packets);
    }
    ssize_t bytes_read = pread(fd, packets, capacity, midi_input_offset);
    if (bytes_read > 0 && !packet_is_empty(packets, (size_t)bytes_read)) {
        const size_t bytes_consumed =
            write_rx_midi_packets_at(packets, (size_t)bytes_read, start_slot);
        midi_input_offset += (off_t)bytes_consumed;
        /* Log real input reads so the injection path is observable end-to-end
         * (the previous code only logged the no-input/eof branches, which made
         * a working injection indistinguishable from a stalled one). */
        log_script_decision(start_slot ? "midi-read+xmos" : "midi-read",
                            bytes_read, bytes_consumed, packets);
    } else if (start_slot == 0) {
        const size_t bytes_written = fill_scripted_xmos(packets, sizeof(packets));
        write_rx_midi_packets(packets, bytes_written);
        log_script_decision(bytes_read > 0 ? "midi-zero-page" : "midi-empty-read", bytes_read, bytes_written, packets);
    }
    close(fd);
    remember_rx(length);
}

void *mmap(void *address, size_t length, int protection, int flags, int fd, off_t offset) {
    if (!real_mmap_fn) {
        real_mmap_fn = dlsym(RTLD_NEXT, "mmap");
    }

    if (fd_is_spi(fd)) {
        void *result = real_mmap_fn(address, length, protection, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (result != MAP_FAILED) {
            spi_fd = fd;
            spi_map = result;
            spi_map_length = length;
            memset(spi_map, 0, length);
        }
        return result;
    }

    void *result = real_mmap_fn(address, length, protection, flags, fd, offset);
    if (result != MAP_FAILED && fd_is_spi(fd)) {
        spi_fd = fd;
        spi_map = result;
        spi_map_length = length;
    }
    return result;
}

static int handle_spi_ioctl_request(int fd, unsigned long request, unsigned long argument) {
    (void)fd;
    const unsigned int command = (unsigned int)(request & 0xffU);
    if (command == SPI_CMD_SPEED) {
        return 0;
    }
    if (command == SPI_CMD_TRANSFER) {
        static unsigned long xfer_n;
        xfer_n += 1;
        xmos_dbg("xfer #%lu len=%lu\n", xfer_n, (unsigned long)argument);
        write_audio_frame((size_t)argument);
        log_handshake_tx((size_t)argument);
        capture_tx_packet((size_t)argument);
        detect_xmos_query((size_t)argument);
        /*
         * Display forcing is independent from XMOS/MIDI RX replies. Keep it
         * outside the "no XMOS reply emitted" branch; otherwise any active
         * XMOS responder can starve the display pump while audio continues
         * to stream.
         */
        force_next_display_request();
        /*
         * Always inject queued GUI input. emit_xmos_reply returns how many
         * RX bytes it wrote (0 if no reply); inject_midi appends user MIDI
         * into the slots after it. Previously these were mutually exclusive,
         * so a continuously-polling XMOS responder starved all live input.
         */
        const size_t xmos_rx_bytes = emit_xmos_reply((size_t)argument);
        inject_midi((size_t)argument, xmos_rx_bytes);
        log_handshake_rx((size_t)argument);
        pace_spi_transfer();
        return 0;
    }
    return 0;
}

int ioctl(int fd, unsigned long request, ...) {
    va_list arguments;
    va_start(arguments, request);
    const unsigned long argument = va_arg(arguments, unsigned long);
    va_end(arguments);

    if (!real_ioctl_fn) {
        real_ioctl_fn = dlsym(RTLD_NEXT, "ioctl");
    }

    if (fd == spi_fd || fd_is_spi(fd)) {
        return handle_spi_ioctl_request(fd, request, argument);
    }

    return real_ioctl_fn(fd, request, argument);
}

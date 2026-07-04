export function createWheelNormalizer({ threshold = 50 } = {}) {
  let accumulated = 0;

  return {
    push(deltaY) {
      accumulated += Number(deltaY || 0);
      if (accumulated <= -threshold) {
        accumulated = 0;
        return 1;
      }
      if (accumulated >= threshold) {
        accumulated = 0;
        return -1;
      }
      return 0;
    },

    reset() {
      accumulated = 0;
    },
  };
}

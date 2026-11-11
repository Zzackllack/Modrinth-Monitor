/**
 * Resolves with the first fulfilled result. Rejections are collected so the
 * final error carries the most common failure reason. Everything is started at
 * once: callers keep `items` small (a candidate batch), not the whole pool.
 */
function firstSuccess(items, worker) {
  if (!items.length) {
    return Promise.reject(new Error("No candidates to try."));
  }

  return new Promise((resolve, reject) => {
    let remaining = items.length;
    const errors = [];

    for (const item of items) {
      Promise.resolve()
        .then(() => worker(item))
        .then(resolve, (error) => {
          errors.push(error);
          remaining -= 1;
          if (remaining === 0) {
            const summary = errors
              .slice(-3)
              .map((err) => err && err.message)
              .filter(Boolean)
              .join("; ");
            reject(new Error(summary || "All candidates failed."));
          }
        });
    }
  });
}

function shuffle(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

module.exports = { firstSuccess, shuffle };

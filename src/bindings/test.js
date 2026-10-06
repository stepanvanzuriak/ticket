
const clock = await load("Time.js", "$bind$Clock");
const random = await load("Crypto.js", "$bind$Random");
const real = { now: clock?.now, bytes: random?.bytes };

async function load(file, name) {
  try {
    return (await import(`../../../_polar/std/${file}`))[name];
  } catch {
    return undefined;
  }
}

const start = Date.UTC(2026, 0, 1);

export function freeze(ms) {
  if (clock) {
    clock.now = () => ({ $: "Time", _0: ms });
  }
}

export function sequence() {
  let n = 0;

  if (random) {
    random.bytes = (count) => (++n).toString(16).padStart(count * 2, "0");
  }
}

export function reset() {
  freeze(start);
  sequence();
}

export function restore() {
  if (clock) {
    clock.now = real.now;
  }

  if (random) {
    random.bytes = real.bytes;
  }
}

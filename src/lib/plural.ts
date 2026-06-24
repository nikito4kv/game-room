// Русское склонение существительного по числу. forms = [одна, две-четыре, пять+]:
// напр. plural(n, ["игрок", "игрока", "игроков"]). Общий util — чтобы лендинг,
// витрина и комната склоняли одинаково (раньше копия жила в каждом месте).
export function plural(n: number, forms: [string, string, string]): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

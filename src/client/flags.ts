/** Hand-drawn SVG flags — crisp at any size, animatable, zero network. */
const star = (cx: number, cy: number, r: number, fill: string, stroke = '', sw = 0) => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.42;
    pts.push(`${(cx + rr * Math.cos(rad)).toFixed(1)},${(cy + rr * Math.sin(rad)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}" ${stroke ? `stroke="${stroke}" stroke-width="${sw}"` : ''}/>`;
};

const svg = (inner: string) =>
  `<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" aria-hidden="true">${inner}</svg>`;

const FLAGS: Record<string, string> = {
  FRA: svg(`<rect width="20" height="40" fill="#0055A4"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#EF4135"/>`),
  BEL: svg(`<rect width="20" height="40" fill="#1A1A1A"/><rect x="20" width="20" height="40" fill="#FBD116"/><rect x="40" width="20" height="40" fill="#E8112D"/>`),
  MAR: svg(`<rect width="60" height="40" fill="#C1272D"/>${star(30, 20, 11, 'none', '#006233', 2.6)}`),
  ESP: svg(`<rect width="60" height="40" fill="#AA151B"/><rect y="10" width="60" height="20" fill="#F1BF00"/>`),
  NOR: svg(`<rect width="60" height="40" fill="#BA0C2F"/><rect x="14" width="12" height="40" fill="#fff"/><rect y="14" width="60" height="12" fill="#fff"/><rect x="17" width="6" height="40" fill="#00205B"/><rect y="17" width="60" height="6" fill="#00205B"/>`),
  ENG: svg(`<rect width="60" height="40" fill="#fff"/><rect x="26" width="8" height="40" fill="#CE1124"/><rect y="16" width="60" height="8" fill="#CE1124"/>`),
  ARG: svg(`<rect width="60" height="40" fill="#74ACDF"/><rect y="13.3" width="60" height="13.3" fill="#fff"/><circle cx="30" cy="20" r="4.6" fill="#F6B40E" stroke="#85340A" stroke-width=".7"/>`),
  SUI: svg(`<rect width="60" height="40" fill="#DA291C"/><rect x="26" y="9" width="8" height="22" fill="#fff"/><rect x="19" y="16" width="22" height="8" fill="#fff"/>`),
};

export function flagEl(code: string | null, size: '' | 'lg' | 'sm' = '', wave = true): HTMLElement {
  const d = document.createElement('div');
  d.className = `flag ${size} ${wave ? 'flag-wave' : ''}`.trim();
  if (code && FLAGS[code]) d.innerHTML = FLAGS[code];
  else { d.classList.add('tbd'); d.textContent = '؟'; }
  return d;
}

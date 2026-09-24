// Renders the PNG icons iOS and Android still ask for from the one SVG source.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const svg = readFileSync('client/public/icon.svg', 'utf8');
const render = (source: string, size: number, out: string) => {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(`client/public/${out}`, png);
  console.log(out, png.length, 'bytes');
};
render(svg, 180, 'apple-touch-icon.png');
render(svg, 192, 'icon-192.png');
render(svg, 512, 'icon-512.png');
// Maskable: full-bleed background, artwork inside the 80% safe zone.
const maskable = svg.replace('rx="114"', 'rx="0"').replace('<path', '<g transform="translate(51 51) scale(.8)"><path').replace('</svg>', '</g></svg>');
render(maskable, 512, 'icon-512-maskable.png');

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#000"/>
  <g transform="translate(90 125) scale(.74)">${svg.replace(/<\/?svg[^>]*>/g, '')}</g>
  <text x="1104" y="300" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="120" font-weight="700" fill="#fff">Loty</text>
  <text x="1104" y="380" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#8e8e93">Watch together, on the same second.</text>
</svg>`;
render(og, 1200, 'og.png');

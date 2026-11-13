import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const episodePath = process.argv[2] ?? "episodes/cpu-cache/episode.json";
const outputPath = process.argv[3] ?? "out/cpu-cache-storyboard.svg";
const episode = JSON.parse(await readFile(episodePath, "utf8"));

if (episode.schemaVersion !== "1.0.0") {
  throw new Error(`SVG storyboard renderer does not support schema ${episode.schemaVersion}`);
}

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
})[char]);

const width = 1600;
const cardWidth = 720;
const cardHeight = 300;
const gap = 32;
const columns = 2;
const rows = Math.ceil(episode.shots.length / columns);
const height = 170 + rows * (cardHeight + gap);
const narration = new Map(episode.narration.map((item) => [item.id, item]));
const colors = ["#55d6e8", "#7296ff", "#ffb45e", "#78dfad", "#ff7c85", "#a78bfa", "#55d6e8"];

const cards = episode.shots.map((shot, index) => {
  const x = 80 + (index % columns) * (cardWidth + gap);
  const y = 150 + Math.floor(index / columns) * (cardHeight + gap);
  const color = colors[index % colors.length];
  const narrationText = shot.narrationIds
    .map((id) => narration.get(id)?.text ?? "")
    .join(" ");
  const wrap = (text, max = 42) => {
    const chars = [...text];
    const lines = [];
    for (let i = 0; i < chars.length; i += max) lines.push(chars.slice(i, i + max).join(""));
    return lines.slice(0, 3);
  };
  const summaryLines = wrap(shot.sceneIntent.summary, 40);
  const narrationLines = wrap(narrationText, 42);
  const text = (lines, startY, fill, size) => lines.map((line, i) =>
    `<text x="${x + 28}" y="${startY + i * (size + 9)}" fill="${fill}" font-size="${size}">${escapeXml(line)}</text>`
  ).join("");
  const duration = (shot.durationFrames / episode.episode.fps).toFixed(1);
  return `
    <g>
      <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="22" fill="#102238" stroke="${color}" stroke-width="2"/>
      <text x="${x + 28}" y="${y + 42}" fill="${color}" font-size="18" font-weight="700">${String(index + 1).padStart(2, "0")} · ${escapeXml(shot.sceneType)}</text>
      <text x="${x + cardWidth - 28}" y="${y + 42}" fill="#9db0c7" font-size="17" text-anchor="end">${duration}s</text>
      ${text(summaryLines, y + 92, "#f4f7fb", 22)}
      <line x1="${x + 28}" y1="${y + 166}" x2="${x + cardWidth - 28}" y2="${y + 166}" stroke="#29445c"/>
      <text x="${x + 28}" y="${y + 202}" fill="#55d6e8" font-size="16">NARRATION</text>
      ${text(narrationLines, y + 238, "#c5d2df", 17)}
    </g>`;
}).join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#07111f"/>
  <text x="80" y="66" fill="#55d6e8" font-size="18" font-weight="700" letter-spacing="4">SCIENCEMOTION · SVG STORYBOARD RENDERER</text>
  <text x="80" y="112" fill="#f4f7fb" font-size="34" font-weight="700">${escapeXml(episode.episode.title)}</text>
  ${cards}
</svg>`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, svg, "utf8");
console.log(`Rendered ${episode.shots.length} shots with renderer svg-storyboard@1.0.0`);
console.log(`Episode package was read-only; output: ${outputPath}`);

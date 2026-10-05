import data from './coordinates.json';
import type { ReactNode } from 'react';
const coordinates = data.coordinates as Record<string, number[]>;
const pattern = new RegExp(
  Object.keys(coordinates)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'gu',
);
export function EmojiText({ text }: { text: string }) {
  const output: ReactNode[] = [];
  let index = 0;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > index) output.push(text.slice(index, match.index));
    const [x, y] = coordinates[match[0]];
    output.push(
      <span
        key={match.index}
        role="img"
        aria-label={match[0]}
        className="inline-emoji"
        style={{
          backgroundImage: 'url(/emoji/twitter.png)',
          backgroundSize: `${data.sheet.cols * 100}% ${data.sheet.rows * 100}%`,
          backgroundPosition: `${(x / (data.sheet.cols - 1)) * 100}% ${(y / (data.sheet.rows - 1)) * 100}%`,
        }}
      >
        <span>{match[0]}</span>
      </span>,
    );
    index = match.index + match[0].length;
  }
  if (index < text.length) output.push(text.slice(index));
  return <>{output}</>;
}

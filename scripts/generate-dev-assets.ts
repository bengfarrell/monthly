import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const startYear = new Date().getUTCFullYear() - 1;
const months = Array.from({ length: 24 }, (_, index) => {
  const month = `${startYear + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
  const items = Array.from({ length: index * 7 % 31 }, (_, assetIndex) => {
    const name = `photo-${String(assetIndex + 1).padStart(2, "0")}.jpg`;
    return {
      key: `mock-assets/${month.replace("-", "/")}/${name}`,
      size: 40000 + (index * 7919 + assetIndex * 13007) % 4000000,
      modified: `${month}-${String(assetIndex % 28 + 1).padStart(2, "0")}T12:00:00.000Z`,
      url: `https://picsum.photos/seed/monthly-${month}-${assetIndex + 1}/800/600`,
    };
  });
  return { month, items };
});

const directory = new URL("../dev/", import.meta.url);
mkdirSync(directory, { recursive: true });
const filename = new URL("assets.json", directory);
writeFileSync(filename, JSON.stringify({ months }, null, 2) + "\n");
console.log(`Generated ${months.reduce((total, month) => total + month.items.length, 0)} assets across 24 months in ${fileURLToPath(filename)}.`);

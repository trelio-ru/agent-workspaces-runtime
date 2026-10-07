import fs from "node:fs/promises";

// Только локальный synthetic URI handler для Windows CI. Реальные OAuth URLs
// сюда не передаются; production runtime никогда не сохраняет их в файл.
const [capturePath, ...urls] = process.argv.slice(2);
await fs.writeFile(capturePath, JSON.stringify(urls), { flag: "wx" });

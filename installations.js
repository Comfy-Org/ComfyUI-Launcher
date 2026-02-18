const path = require("path");
const fs = require("fs");
const paths = require("./lib/paths");

const dataPath = path.join(paths.dataDir(), "installations.json");

async function load() {
  try {
    return JSON.parse(await fs.promises.readFile(dataPath, "utf-8"));
  } catch {
    return [];
  }
}

async function save(installations) {
  await fs.promises.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.promises.writeFile(dataPath, JSON.stringify(installations, null, 2));
}

async function list() {
  return load();
}

async function add(installation) {
  const installations = await load();
  const entry = {
    id: `inst-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...installation,
  };
  installations.push(entry);
  await save(installations);
  return entry;
}

async function remove(id) {
  const installations = (await load()).filter((i) => i.id !== id);
  await save(installations);
}

async function update(id, data) {
  const installations = await load();
  const index = installations.findIndex((i) => i.id === id);
  if (index === -1) return null;
  installations[index] = { ...installations[index], ...data };
  await save(installations);
  return installations[index];
}

async function get(id) {
  return (await load()).find((i) => i.id === id) || null;
}

async function reorder(orderedIds) {
  const installations = await load();
  const byId = Object.fromEntries(installations.map((i) => [i.id, i]));
  const reordered = orderedIds.map((id) => byId[id]).filter(Boolean);
  // Append any installations not in the provided list (safety net)
  for (const inst of installations) {
    if (!orderedIds.includes(inst.id)) reordered.push(inst);
  }
  await save(reordered);
}

module.exports = { list, add, remove, update, get, reorder };

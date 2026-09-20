import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const root = path.resolve('data');
export const assets = path.join(root, 'assets');
const dbFile = path.join(root, 'studio.json');
let db = { personas: [], episodes: [] };
let saveChain = Promise.resolve();

export async function initStore() {
  await mkdir(assets, { recursive: true });
  try { db = JSON.parse(await readFile(dbFile, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const episode of db.episodes) {
    if (episode.status === 'running' || episode.status === 'preparing') {
      episode.status = 'interrupted';
      episode.error = 'The server stopped during this episode.';
    }
  }
  await save();
}

export function listPersonas() { return db.personas; }
export function listEpisodes() { return db.episodes; }
export function persona(id) { return db.personas.find(item => item.id === id); }
export function episode(id) { return db.episodes.find(item => item.id === id); }
export function uid() { return randomUUID(); }
export function stamp() { return new Date().toISOString(); }

export async function save() {
  saveChain = saveChain.then(async () => {
    const tmp = `${dbFile}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dbFile);
  });
  return saveChain;
}

export async function addPersona(item) { db.personas.unshift(item); await save(); return item; }
export async function updatePersona(id, item) {
  const index = db.personas.findIndex(p => p.id === id);
  if (index < 0) return null;
  db.personas[index] = { ...db.personas[index], ...item, id };
  await save(); return db.personas[index];
}
export async function deletePersona(id) { db.personas = db.personas.filter(p => p.id !== id); await save(); }
export async function addEpisode(item) { db.episodes.unshift(item); await save(); return item; }
export async function putAsset(name, data) { const file = path.join(assets, `${uid()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`); await writeFile(file, data); return `/assets/${path.basename(file)}`; }

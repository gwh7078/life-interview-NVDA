#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const datasetPath = process.argv[2] ?? path.join(root, 'data/era-context/era-context.zh-CN.jsonl');
const manifestPath = process.argv[3] ?? path.join(root, 'data/era-context/source-manifest.jsonl');
const categories = new Set(['社会', '时事', '音乐', '影视', '娱乐', '体育', '科技', '互联网', '消费', '教育', '工作就业', '日常生活方式']);
const records = parseJsonl(await readFile(datasetPath, 'utf8'), 'dataset');
const manifest = parseJsonl(await readFile(manifestPath, 'utf8'), 'manifest');
const seen = new Set();
const categoryCounts = {};
const yearCounts = {};

for (const record of records) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('Every dataset row must be an object.');
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'category,end_year,start_year,summary,title') fail(`Dataset row fields are not exact: ${keys.join(',')}`);
  if (!Number.isInteger(record.start_year) || !Number.isInteger(record.end_year)
    || record.start_year < 1970 || record.end_year > 2020 || record.start_year > record.end_year) {
    fail(`Invalid year range in ${record.title ?? 'unknown record'}.`);
  }
  if (!categories.has(record.category)) fail(`Unsupported category: ${record.category}`);
  for (const key of ['title', 'summary']) {
    if (typeof record[key] !== 'string' || !record[key].trim()) fail(`Missing ${key} in ${record.title ?? 'unknown record'}.`);
  }
  const key = JSON.stringify(record);
  if (seen.has(key)) fail(`Duplicate record: ${record.title}`);
  seen.add(key);
  categoryCounts[record.category] = (categoryCounts[record.category] ?? 0) + 1;
  yearCounts[record.start_year] = (yearCounts[record.start_year] ?? 0) + 1;
}

if (records.length < 1500) fail(`Dataset must contain at least 1500 records; got ${records.length}.`);
if (manifest.length !== records.length) fail(`Manifest count ${manifest.length} does not match dataset count ${records.length}.`);
for (const item of manifest) {
  if (!item || typeof item.record_id !== 'string' || !item.source_url || !item.source_title) {
    fail('Manifest rows require record_id, source_url and source_title.');
  }
}

console.log(JSON.stringify({
  records: records.length,
  categories: categoryCounts,
  startYears: yearCounts,
  manifest: manifest.length,
}));

function parseJsonl(text, label) {
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`${label} line ${index + 1} is not valid JSON.`);
    }
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

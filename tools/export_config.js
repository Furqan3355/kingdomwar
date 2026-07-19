#!/usr/bin/env node
// tools/export_config.js
//
// Implements the export half of the pipeline in Volume 1 §9.2:
//   [Unity ScriptableObject] -> [Editor export -> JSON] -> THIS SCRIPT -> Postgres
//
// Input: a JSON file matching the shape Unity's editor export tool would
// produce (see sample-config.json in this same folder).
// Output: SQL INSERT statements written to stdout, safe to pipe into psql,
// OR applied directly if --apply is passed with DB connection env vars set.
//
// Usage:
//   node export_config.js sample-config.json > migration.sql
//   node export_config.js sample-config.json --apply

const fs = require('fs');
const path = require('path');

function toSql(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function buildSql(config) {
  const lines = [];

  for (const building of config.buildings) {
    lines.push(
      `INSERT INTO building_config (building_id, display_name, max_level, category, unlock_castle_level) ` +
      `VALUES (${toSql(building.buildingId)}, ${toSql(building.displayName)}, ${building.maxLevel}, ` +
      `${toSql(building.category)}, ${building.unlockCastleLevel}) ` +
      `ON CONFLICT (building_id) DO UPDATE SET display_name = EXCLUDED.display_name, ` +
      `max_level = EXCLUDED.max_level, category = EXCLUDED.category, ` +
      `unlock_castle_level = EXCLUDED.unlock_castle_level;`
    );

    for (const lvl of building.levels) {
      const productionRate = lvl.productionRate === null || lvl.productionRate === undefined
        ? 'NULL'
        : lvl.productionRate;
      lines.push(
        `INSERT INTO building_level_config ` +
        `(building_id, level, upgrade_time_seconds, cost_gold, cost_crystal, cost_mithril, production_rate) ` +
        `VALUES (${toSql(building.buildingId)}, ${lvl.level}, ${lvl.upgradeTimeSeconds}, ` +
        `${lvl.costGold}, ${lvl.costCrystal}, ${lvl.costMithril}, ${productionRate}) ` +
        `ON CONFLICT (building_id, level) DO UPDATE SET ` +
        `upgrade_time_seconds = EXCLUDED.upgrade_time_seconds, cost_gold = EXCLUDED.cost_gold, ` +
        `cost_crystal = EXCLUDED.cost_crystal, cost_mithril = EXCLUDED.cost_mithril, ` +
        `production_rate = EXCLUDED.production_rate;`
      );
    }
  }

  return lines.join('\n');
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node export_config.js <config.json> [--apply]');
    process.exit(1);
  }
  const raw = fs.readFileSync(path.resolve(inputPath), 'utf-8');
  const config = JSON.parse(raw);
  const sql = buildSql(config);

  if (process.argv.includes('--apply')) {
    // Left as an exercise for CI wiring: pipe `sql` into psql via child_process,
    // using the same DB_HOST/DB_PORT/DB_USER/DB_NAME env vars as
    // apply_custom_migrations.sh. Kept out of this script to avoid adding a
    // pg client dependency for what is fundamentally a text-generation tool.
    console.error('--apply not implemented in this scaffold: pipe stdout into psql instead, e.g.');
    console.error('  node export_config.js sample-config.json | psql "$DATABASE_URL"');
    process.exit(1);
  }

  console.log(sql);
}

main();

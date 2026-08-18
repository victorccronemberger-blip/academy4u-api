// ============================================================================
// SEED ART MAPPINGS — popula academy_art_mappings a partir de um JSON.
// ----------------------------------------------------------------------------
// Uso:
//   node scripts/seed-art-mappings.mjs <arquivo-json>
// Exemplo (arquivo.json):
//   [
//     { "courseId": 1738, "artTag": "cfp-2026_54", "artIdCurso": 1738, "artTurma": 4155 },
//     { "courseId": 1338, "artTag": "cpa2026",     "artIdCurso": 1338, "artTurma": 4000 },
//     { "courseId": 1339, "artTag": "cproi2026",   "artIdCurso": 1339, "artTurma": 4001 }
//   ]
// O courseId é o id da tabela `courses` do LMS (course_id dos itens de pedido).
// A tag/turma/id_curso são os valores reais da plataforma ART (validar ao vivo
// com find-turma.mjs: node find-turma.mjs <tag> <turma>).
// ============================================================================
import { readFileSync } from "node:fs";
import { createMySqlStore } from "../src/store/mysql-store.js";

const MYSQL_URL = process.env.MYSQL_URL;
const FILE = process.argv[2];

if (!MYSQL_URL) {
  console.error("MYSQL_URL não definida. Exporte a variável antes de rodar.");
  process.exit(1);
}
if (!FILE) {
  console.error("Uso: node scripts/seed-art-mappings.mjs <arquivo-json>");
  process.exit(1);
}

const rows = JSON.parse(readFileSync(FILE, "utf8"));
if (!Array.isArray(rows) || !rows.length) {
  console.error("O arquivo deve conter um array de mapeamentos.");
  process.exit(1);
}

const store = createMySqlStore(MYSQL_URL);
try {
  for (const row of rows) {
    const saved = await store.saveArtMapping({
      courseId: row.courseId ?? row.course_id,
      artTag: row.artTag ?? row.art_tag,
      artIdCurso: row.artIdCurso ?? row.art_id_curso,
      artTurma: row.artTurma ?? row.art_turma,
      active: row.active !== false,
    });
    if (saved) {
      console.log(`✅ courseId=${saved.courseId} -> ${saved.artTag} (id_curso=${saved.artIdCurso}, turma=${saved.artTurma})`);
    } else {
      console.log(`⏸️ courseId=${row.courseId ?? row.course_id} desativado (${row.artTag ?? row.art_tag ?? "sem tag"}) — salvo como inativo`);
    }
  }
  console.log("\nSeed concluído. Lembre-se de habilitar ART_ENABLED=true.");
} catch (error) {
  console.error("Falha no seed:", error?.message ?? error);
  process.exit(1);
} finally {
  await store.close?.();
}

import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

const COURSE_SLUG = "novo-cpa";
const LIBRARY_ID = "719981";
const CONTENT_ROOT = path.resolve(process.argv[2] || process.env.CPA_CONTENT_DIR || "");
const REPLACE = process.argv.includes("--replace");

const videoMap = new Map(Object.entries({
  "01": ["1ebb1353-b8fc-48fc-a2bd-17d00bb47f86", "00:47:14"],
  "02": ["35823b70-617d-4e6a-b84b-779c7d8a6717", "00:41:23"],
  "03": ["498f9394-6f4c-4e56-b90b-313bfa9b82cf", "00:52:08"],
  "04": ["0670db6c-e031-4e8e-95b2-ea61659e9e6b", "00:38:44"],
  "05": ["f4482f63-2b4a-4b63-b588-1468772c55cb", "00:44:07"],
  "06": ["a2f5b9fa-23fc-458d-9caf-3e82da8b63fb", "00:22:08"],
  "07": ["bf808ef9-1081-4c50-8877-32e570c55c0a", "00:49:42"],
  "08": ["6d8b3b08-db7a-4300-b011-38aa2970e0a8", "01:03:34"],
  "09": ["1b0feb64-3cc2-494a-ad1d-5bb0d6c486ba", "00:54:30"],
  "10": ["8e7fc58b-5044-4fa3-b9f9-ebedbd77346b", "01:18:11"],
  "11": ["b13f630b-c5aa-4090-810a-b29602ce9a99", "00:28:09"],
  "12": ["a1a2647e-8496-44b8-85f3-8280fb848403", "01:06:11"],
  "13": ["63c0178b-fa75-4da9-aa4a-2f92e9fadeb2", "00:43:00"],
  "14": ["9bb2e49c-65fe-4616-b02c-092b5a6f5dea", "00:57:13"],
  "15": ["fd52631b-8c50-4234-9d9c-2cbecf39ba06", "00:54:37"],
  "16": ["a7a559c1-f8cf-4568-b656-52b692531756", "00:46:18"],
  "17": ["c8e33448-3c4b-4390-acb4-5e352bf3d141", "01:00:48"],
  "18": ["e38fbe87-4beb-467f-9e5e-1c381f2b6c95", "00:44:26"],
  "19": ["3d4e54f2-7581-421e-9786-7152c4e7d178", "00:56:45"],
  "20": ["29659424-b160-4e48-9c9b-ef3488bf619d", "01:00:09"],
  "21": ["b0baa1a1-4f84-4527-a92e-bdf44b9930d8", "00:39:52"],
  "22": ["07b6db40-67de-4362-970c-ce27e01b8f71", "00:19:27"],
  "23": ["9771d106-59f7-4a6e-9008-6c86a4f069f4", "00:41:24"],
  "24": ["9f5824f4-cdb6-47cf-8e7b-6f9c459b103c", "00:45:44"],
  "25": ["221d1642-bba9-4384-961d-58afd01abaf0", "00:46:10"],
  "26": ["2f726daa-d6b5-48de-a857-d7b4d12e6005", "00:33:17"],
  "27": ["9012c3c0-111a-4c48-9654-58953abff6ef", "00:58:24"],
  "28": ["9e8aa8db-3ab7-4ecd-af61-09e2044cc676", "00:23:42"],
  "29": ["765274a9-9399-4f32-a194-1e7087570ffc", "00:33:05"],
  "30": ["f5e946c7-d555-4eae-8443-192b67058912", "00:36:26"],
  "31": ["a216be9d-9486-4ae8-8e4b-33176ecf12f1", "00:29:32"],
  "32": ["35d05f23-37e8-455b-b77e-e96c8f7cae8e", "00:37:48"],
  "39": ["4d3eef9c-6c81-4913-85c2-87dbc07caab2", "00:22:04"],
}));

const moduleDefinitions = [
  { title: "Comece por aqui", summary: "Boas-vindas, método de estudo e estratégia para a prova.", numbers: [1, 39] },
  { title: "Sistema Financeiro e conduta", summary: "SFN, participantes, regulação, distribuição e ética.", numbers: [2, 3, 4, 5, 6] },
  { title: "Economia, finanças e renda fixa", summary: "Indicadores, política econômica, matemática financeira, investimentos e renda fixa.", numbers: [7, 8, 9, 10, 11, 12] },
  { title: "Mercado, fundos e risco", summary: "Mercado de capitais, governança, fundos, tributação e gestão de riscos.", numbers: [13, 14, 15, 16, 17, 18] },
  { title: "Previdência e planejamento", summary: "Previdência, produtos bancários, seguros, finanças pessoais e planejamento.", numbers: [19, 20, 21, 22, 23, 24, 25] },
  { title: "Atendimento, compliance e inovação", summary: "Atendimento, PLD/LGPD, crimes, ASG, DeFi, Open Finance e IA.", numbers: [26, 27, 28, 29, 30, 31, 32] },
];

function seconds(value) {
  return value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

function numberFromName(filename) {
  return filename.match(/^(\d{2})_/)?.[1] ?? null;
}

function lessonTitle(filename) {
  return filename
    .replace(/\.mp4$/i, "")
    .replace(/^\d{2}_[^_]+_/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL is required.");
if (!CONTENT_ROOT) throw new Error("Pass the NOVO-CPA content directory as the first argument.");

const videosDir = path.join(CONTENT_ROOT, "Videos");
const pdfsDir = path.join(CONTENT_ROOT, "PDFs");
const questionsDir = path.join(CONTENT_ROOT, "Questoes");
const videoFiles = (await fs.readdir(videosDir)).filter((name) => name.toLowerCase().endsWith(".mp4"));
const pdfFiles = new Map((await fs.readdir(pdfsDir)).filter((name) => name.toLowerCase().endsWith(".pdf")).map((name) => [numberFromName(name), name]));
const questionFiles = (await fs.readdir(questionsDir)).filter((name) => name.toLowerCase().endsWith(".json")).sort();
const videoFilesByNumber = new Map(videoFiles.map((name) => [numberFromName(name), name]));

for (const number of videoMap.keys()) {
  if (!videoFilesByNumber.has(number)) throw new Error(`Missing video file ${number}.`);
}

const connection = await mysql.createConnection({ uri: process.env.MYSQL_URL, timezone: "Z", dateStrings: true });
try {
  await connection.beginTransaction();
  const [[existing]] = await connection.query("SELECT course_slug FROM learning_courses WHERE course_slug=?", [COURSE_SLUG]);
  if (existing && !REPLACE) throw new Error("CPA 2026 already exists. Re-run with --replace only when an intentional content reset is required.");
  if (existing) await connection.query("DELETE FROM learning_courses WHERE course_slug=?", [COURSE_SLUG]);

  await connection.query(
    "INSERT INTO learning_courses (course_slug,title,description,bunny_library_id,active) VALUES (?,?,?,?,1)",
    [COURSE_SLUG, "CPA 2026", "Preparação completa para a certificação CPA, com aulas, materiais, exercícios por tema e simulados.", LIBRARY_ID],
  );

  const lessonIdByNumber = new Map();
  let globalOrder = 1;
  for (let moduleIndex = 0; moduleIndex < moduleDefinitions.length; moduleIndex += 1) {
    const module = moduleDefinitions[moduleIndex];
    const [moduleResult] = await connection.query(
      "INSERT INTO learning_modules (course_slug,title,summary,sort_order) VALUES (?,?,?,?)",
      [COURSE_SLUG, module.title, module.summary, moduleIndex + 1],
    );
    for (const numeric of module.numbers) {
      const number = String(numeric).padStart(2, "0");
      const filename = videoFilesByNumber.get(number);
      const [videoId, duration] = videoMap.get(number);
      const lessonId = `${COURSE_SLUG}-${number}`;
      lessonIdByNumber.set(number, lessonId);
      const pdfName = pdfFiles.get(number) ?? null;
      await connection.query(
        `INSERT INTO learning_lessons
         (id,course_slug,module_id,title,bunny_video_id,duration_seconds,material_path,sort_order,published)
         VALUES (?,?,?,?,?,?,?,?,1)`,
        [lessonId, COURSE_SLUG, moduleResult.insertId, lessonTitle(filename), videoId, seconds(duration), pdfName ? `cpa-2026/${pdfName}` : null, globalOrder],
      );
      globalOrder += 1;
    }
  }

  let quizOrder = 1;
  let questionTotal = 0;
  for (const filename of questionFiles) {
    const number = numberFromName(filename);
    const source = JSON.parse(await fs.readFile(path.join(questionsDir, filename), "utf8"));
    const isSimulation = Number(number) >= 33;
    const simulationNumber = Number(number) - 32;
    const quizId = isSimulation ? `${COURSE_SLUG}-simulado-${String(simulationNumber).padStart(2, "0")}` : `${COURSE_SLUG}-aula-${number}`;
    const title = isSimulation
      ? (number === "38" ? "Simulado oficial CPA" : `Simulado CPA ${String(simulationNumber).padStart(2, "0")}`)
      : `Exercícios — ${String(source.titulo ?? lessonTitle(filename)).trim()}`;
    await connection.query(
      `INSERT INTO learning_quizzes
       (id,course_slug,lesson_id,title,kind,time_limit_minutes,passing_score_bps,sort_order,published)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      [quizId, COURSE_SLUG, isSimulation ? null : lessonIdByNumber.get(number), title, isSimulation ? "simulation" : "exercise", isSimulation ? (number === "38" ? 120 : 90) : null, 7000, quizOrder],
    );
    quizOrder += 1;
    for (let questionIndex = 0; questionIndex < source.questions.length; questionIndex += 1) {
      const question = source.questions[questionIndex];
      const [questionResult] = await connection.query(
        "INSERT INTO learning_questions (quiz_id,external_code,prompt,explanation,sort_order) VALUES (?,?,?,?,?)",
        [quizId, String(question.code ?? question.id_questao ?? ""), decodeHtml(question.enunciado), decodeHtml(question.questao_comentada), questionIndex + 1],
      );
      const options = Array.isArray(question.answers) ? question.answers : [];
      for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
        const option = options[optionIndex];
        await connection.query(
          "INSERT INTO learning_question_options (question_id,body,is_correct,sort_order) VALUES (?,?,?,?)",
          [questionResult.insertId, decodeHtml(option.resposta), Number(option.correta) === 1 ? 1 : 0, optionIndex + 1],
        );
      }
      questionTotal += 1;
    }
  }

  await connection.commit();
  console.log(JSON.stringify({ imported: true, courseSlug: COURSE_SLUG, modules: moduleDefinitions.length, lessons: videoMap.size, quizzes: questionFiles.length, questions: questionTotal }));
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  await connection.end();
}

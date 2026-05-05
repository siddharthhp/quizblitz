// Parses uploaded .docx into a normalized question array.
// Supports two author formats:
//   FORMAT A (prose):
//       Q: <question text>
//       A) option 1
//       B) option 2 ✓        <-- correct option marked with ✓ or *
//       C) option 3
//       D) option 4
//
//   FORMAT B (table):  one row per question
//       | Question | A | B | C | D | Answer |
//       Answer column holds the letter (A/B/C/D) of the correct option.

const mammoth = require('mammoth');

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isCorrectMarker(text) {
  return /[✓✔]|\(correct\)|\*\s*$/i.test(text);
}

function cleanOption(text) {
  return text
    .replace(/^[A-Fa-f][).:\-]\s*/, '')
    .replace(/[✓✔]/g, '')
    .replace(/\(correct\)/gi, '')
    .replace(/\*\s*$/, '')
    .trim();
}

function parseProse(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const questions = [];
  let current = null;

  const optionRe = /^([A-Fa-f])[).:\-]\s+(.*)$/;
  const questionRe = /^(?:Q[:.\-]\s*|Q\d+[:.\-]\s*|\d+[).:\-]\s*)(.+)$/i;

  const flush = () => {
    if (!current) return;
    if (current.options.length >= 2 && current.correctIndex >= 0) {
      questions.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const qMatch = line.match(questionRe);
    const oMatch = line.match(optionRe);

    if (qMatch && !oMatch) {
      flush();
      current = { question: qMatch[1].trim(), options: [], correctIndex: -1 };
      continue;
    }

    if (oMatch && current) {
      const isCorrect = isCorrectMarker(line);
      current.options.push(cleanOption(oMatch[2]));
      if (isCorrect) current.correctIndex = current.options.length - 1;
      continue;
    }

    if (current && current.options.length === 0) {
      current.question = `${current.question} ${line}`.trim();
    }
  }
  flush();

  return questions;
}

function parseTables(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const questions = [];

  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 2) continue;

    const headerCells = (rows[0].match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(
      (c) => stripTags(c).toLowerCase(),
    );
    const answerCol = headerCells.findIndex((h) => /answer|correct/.test(h));
    const questionCol = headerCells.findIndex((h) => /question|q\b/.test(h));
    if (answerCol === -1 || questionCol === -1) continue;

    const optionCols = [];
    headerCells.forEach((h, idx) => {
      if (/^[a-f]$|option\s*[a-f]/i.test(h)) optionCols.push(idx);
    });
    if (optionCols.length < 2) continue;

    for (let i = 1; i < rows.length; i++) {
      const cells = (rows[i].match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map(stripTags);
      if (!cells.length) continue;
      const qText = cells[questionCol];
      const answerLetter = (cells[answerCol] || '').trim().toUpperCase().charAt(0);
      const options = optionCols.map((c) => cells[c] || '').filter(Boolean);
      const correctIndex = LETTERS.indexOf(answerLetter);
      if (qText && options.length >= 2 && correctIndex >= 0 && correctIndex < options.length) {
        questions.push({ question: qText, options, correctIndex });
      }
    }
  }

  return questions;
}

async function parseDocxBuffer(buffer) {
  const [{ value: html }, { value: text }] = await Promise.all([
    mammoth.convertToHtml({ buffer }),
    mammoth.extractRawText({ buffer }),
  ]);

  let questions = parseTables(html);
  if (questions.length === 0) {
    questions = parseProse(text);
  }

  return questions.map((q, idx) => ({
    id: idx + 1,
    question: q.question,
    options: q.options,
    correctIndex: q.correctIndex,
  }));
}

module.exports = { parseDocxBuffer, parseProse, parseTables };

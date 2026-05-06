#!/usr/bin/env node
// Generates sample-questions.docx in the project root using the prose format.
// Run: node server/scripts/gen-sample.js

const path = require('path');
const fs = require('fs');
const { Document, Paragraph, TextRun, Packer, HeadingLevel } = require(
  path.join(__dirname, '..', 'node_modules', 'docx'),
);

const QUESTIONS = [
  {
    q: 'What is the capital of France? (15)',
    options: ['London', 'Berlin', 'Paris', 'Madrid'],
    answer: 'C',
  },
  {
    q: 'Which planet is closest to the Sun? (20)',
    options: ['Venus', 'Mercury', 'Earth', 'Mars'],
    answer: 'B',
  },
  {
    q: 'How many sides does a hexagon have? (10)',
    options: ['5', '6', '7', '8'],
    answer: 'B',
  },
  {
    q: 'Who wrote Romeo and Juliet? (20)',
    options: ['Charles Dickens', 'Jane Austen', 'William Shakespeare', 'Homer'],
    answer: 'C',
  },
  {
    q: 'What is 12 × 12? (15)',
    options: ['124', '144', '132', '148'],
    answer: 'B',
  },
  {
    q: 'Which element has the chemical symbol O? (10)',
    options: ['Gold', 'Osmium', 'Oxygen', 'Oganesson'],
    answer: 'C',
  },
  {
    q: 'In which year did World War II end? (20)',
    options: ['1943', '1944', '1946', '1945'],
    answer: 'D',
  },
  {
    q: 'What is the largest ocean on Earth? (15)',
    options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'],
    answer: 'D',
  },
  {
    q: 'Which language runs in a web browser natively? (20)',
    options: ['Python', 'Java', 'JavaScript', 'Ruby'],
    answer: 'C',
  },
  {
    q: 'What is the speed of light (approx) in km/s? (30)',
    options: ['150,000', '300,000', '450,000', '600,000'],
    answer: 'B',
  },
];

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function buildParagraphs() {
  const paras = [];

  paras.push(
    new Paragraph({
      children: [new TextRun({ text: 'RetailBlitz Sample Questions', bold: true, size: 36 })],
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 200 },
    }),
  );

  paras.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Format: Q: <question> (seconds)  →  options A-D  →  Answer: <letter>',
          italics: true,
          color: '666666',
        }),
      ],
      spacing: { after: 400 },
    }),
  );

  QUESTIONS.forEach((item, idx) => {
    // Question line
    paras.push(
      new Paragraph({
        children: [new TextRun({ text: `Q${idx + 1}: ${item.q}`, bold: true })],
        spacing: { before: 300, after: 100 },
      }),
    );

    // Option lines
    item.options.forEach((opt, i) => {
      paras.push(
        new Paragraph({
          children: [new TextRun(`${LETTERS[i]}) ${opt}`)],
          spacing: { after: 60 },
          indent: { left: 360 },
        }),
      );
    });

    // Answer line
    paras.push(
      new Paragraph({
        children: [
          new TextRun({ text: `Answer: ${item.answer}`, bold: true, color: '0070C0' }),
        ],
        spacing: { before: 80, after: 200 },
        indent: { left: 360 },
      }),
    );
  });

  return paras;
}

async function main() {
  const doc = new Document({
    sections: [{ properties: {}, children: buildParagraphs() }],
  });

  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join(__dirname, '..', '..', 'sample-questions.docx');
  fs.writeFileSync(outPath, buffer);
  console.log(`Written: ${outPath} (${buffer.length} bytes)`);

  // Round-trip verify
  const { parseDocxBuffer } = require('../parser');
  const parsed = await parseDocxBuffer(buffer);
  if (parsed.length !== QUESTIONS.length) {
    console.error(`❌ Round-trip FAILED: expected ${QUESTIONS.length}, got ${parsed.length}`);
    process.exit(1);
  }
  const wrong = parsed.filter((q, i) => {
    const expectedIdx = LETTERS.indexOf(QUESTIONS[i].answer);
    return q.correctIndex !== expectedIdx;
  });
  if (wrong.length > 0) {
    console.error(`❌ Wrong answer index in: ${wrong.map((q) => q.question).join(', ')}`);
    process.exit(1);
  }
  console.log(`✅ Round-trip OK: ${parsed.length} questions parsed, all answers correct`);
  parsed.forEach((q, i) => {
    console.log(`  Q${i + 1} [${q.durationSec}s]: ${q.question.slice(0, 50)}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });

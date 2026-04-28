import fs from 'fs';
import { parseSpanLine, ParsedSpan } from './spans';
import { addNode, addEdge } from './graph';
import { recordSpan, registerService } from './health';

const SPANS_FILE = process.env.SPANS_FILE ?? '/var/log/otel/spans.jsonl';
const BOOTSTRAP_LINES = 500;

function processSpans(spans: ParsedSpan[]): void {
  for (const span of spans) {
    addNode(span.source);
    addNode(span.target);
    addEdge(span.source, span.target);
    recordSpan(span.source, span.status === 'error');
    registerService(span.target);
  }
}

export async function bootstrapGraph(): Promise<void> {
  if (!fs.existsSync(SPANS_FILE)) {
    console.log(`Spans file not found at ${SPANS_FILE}, starting with empty graph`);
    return;
  }

  const content = fs.readFileSync(SPANS_FILE, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const tail = lines.slice(-BOOTSTRAP_LINES);

  for (const line of tail) {
    processSpans(parseSpanLine(line));
  }

  console.log(`Bootstrapped graph from ${tail.length} lines`);
}

export function startTail(onSpan: (span: ParsedSpan) => void): void {
  let offset = fs.existsSync(SPANS_FILE) ? fs.statSync(SPANS_FILE).size : 0;
  let remainder = '';

  fs.watchFile(SPANS_FILE, { interval: 500 }, (curr) => {
    if (curr.size <= offset) return;

    const stream = fs.createReadStream(SPANS_FILE, { start: offset, end: curr.size - 1 });
    const chunks: Buffer[] = [];

    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    stream.on('end', () => {
      offset = curr.size;
      const text = remainder + Buffer.concat(chunks).toString('utf8');
      const lines = text.split('\n');
      remainder = lines.pop() ?? '';

      for (const line of lines) {
        const spans = parseSpanLine(line);
        processSpans(spans);
        for (const span of spans) {
          onSpan(span);
        }
      }
    });

    stream.on('error', (err) => {
      console.error('Error reading spans file:', err);
    });
  });

  console.log(`Tailing ${SPANS_FILE} from offset ${offset}`);
}

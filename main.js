import { Command } from 'commander';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import superagent from 'superagent';

const program = new Command();

program.helpOption('--help', 'Вивести довідку');

program
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до теки для кешованих картинок');

program.parse();
const options = program.opts();

const sendResponse = (res, statusCode, contentType, body, extraHeaders = {}) => {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    ...extraHeaders
  });
  res.end(body);
};

const readRequestBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const writeFileAtomic = async (filePath, buffer) => {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
};

const startServer = async () => {
  try {
    await fs.mkdir(options.cache, { recursive: true });
  } catch (err) {
    console.error('Не вдалося створити теку кешу:', err.message);
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];
    const match = urlPath.match(/^\/(\d{3})$/);

    if (!match) {
      sendResponse(
        res,
        404,
        'application/json; charset=utf-8',
        JSON.stringify({ error: 'Некоректний шлях. Очікується формат /<код_стану>, наприклад /200' })
      );
      return;
    }

    const statusCode = match[1];
    const cacheFilePath = path.join(options.cache, `${statusCode}.jpg`);

    try {
      switch (req.method) {
        case 'GET': {
          try {
            const cachedImage = await fs.readFile(cacheFilePath);
            sendResponse(res, 200, 'image/jpeg', cachedImage, { 'X-Cache': 'HIT' });
          } catch (readErr) {
            if (readErr.code !== 'ENOENT') {
              throw readErr;
            }

            try {
              const response = await superagent.get(`https://http.cat/${statusCode}`);
              const imageBuffer = response.body;
              await writeFileAtomic(cacheFilePath, imageBuffer);
              sendResponse(res, 200, 'image/jpeg', imageBuffer, { 'X-Cache': 'MISS' });
            } catch (fetchErr) {
              sendResponse(
                res,
                404,
                'application/json; charset=utf-8',
                JSON.stringify({ error: `Картинку для коду ${statusCode} не знайдено на http.cat` })
              );
            }
          }
          break;
        }

        case 'PUT': {
          const imageBuffer = await readRequestBody(req);
          if (imageBuffer.length === 0) {
            sendResponse(
              res,
              400,
              'application/json; charset=utf-8',
              JSON.stringify({ error: 'Тіло PUT-запиту не може бути порожнім' })
            );
            return;
          }

          await writeFileAtomic(cacheFilePath, imageBuffer);
          sendResponse(
            res,
            201,
            'application/json; charset=utf-8',
            JSON.stringify({ message: `Картинку для коду ${statusCode} збережено в кеш` })
          );
          break;
        }

        case 'DELETE': {
          try {
            await fs.unlink(cacheFilePath);
            sendResponse(
              res,
              200,
              'application/json; charset=utf-8',
              JSON.stringify({ message: `Картинку для коду ${statusCode} видалено з кешу` })
            );
          } catch (unlinkErr) {
            if (unlinkErr.code === 'ENOENT') {
              sendResponse(
                res,
                404,
                'application/json; charset=utf-8',
                JSON.stringify({ error: `Картинку для коду ${statusCode} не знайдено в кеші` })
              );
            } else {
              throw unlinkErr;
            }
          }
          break;
        }

        default:
          sendResponse(
            res,
            405,
            'application/json; charset=utf-8',
            JSON.stringify({ error: `Метод ${req.method} не підтримується` }),
            { Allow: 'GET, PUT, DELETE' }
          );
          break;
      }
    } catch (err) {
      console.error('Внутрішня помилка сервера:', err);
      sendResponse(
        res,
        500,
        'application/json; charset=utf-8',
        JSON.stringify({ error: 'Внутрішня помилка сервера' })
      );
    }
  });

  server.listen(options.port, options.host, () => {
    console.log(`Проксі-сервер запущено: http://${options.host}:${options.port}/`);
  });
};

startServer();
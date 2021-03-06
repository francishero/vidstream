import fs from 'fs';
import path from 'path';
import http from 'http';
import { Queue, Job, QueueContext, QueueMessage } from '@me/common/utils/queue';
import { Executor } from '@me/common/utils/executor';

const REDUCE_QUEUE = process.env.CONFIG_REDUCE_QUEUE;
const port = process.env.CONFIG_HTTP_PORT;
const HLS_BASE_URL = process.env.CONFIG_HLS_BASE_URL;

let queueService: Queue;

function getSplitCommand(
  videoDir: string,
  resolutions: Array<string>,
  context: QueueContext<Job>,
  duration: number = 6
) {
  let command = resolutions.reduce((acc, resolution) => {
    resolution = resolution.toString();

    const videoFolder = path.join(videoDir, resolution);
    const initSegment = path.join(videoFolder, 'init.mp4');
    const segmentTemplate = path.join(videoFolder, '$Number$.m4s');
    const playListName = path.join(videoFolder, 'playlist.m3u8');
    const iframe = path.join(videoFolder, 'iframe.m3u8');
    const inputFile = path.join(videoDir, resolution + '.mp4');

    acc += `'in=${inputFile},stream=video,init_segment=${initSegment},`;
    acc += `segment_template=${segmentTemplate},playlist_name=${playListName},iframe_playlist_name=${iframe}' `;
    return acc;
  }, '');

  const audioFiles = context.jobs.filter(({ type }) => type === 'audio');

  for (let audioFile of audioFiles) {
    const dirName = path.basename(audioFile.fileName, '.mp4');
    const dirPath = path.join(videoDir, dirName);
    const filePath = audioFile.fileName;

    command += `'in=${filePath},stream=audio,init_segment=${path.join(
      dirPath,
      'init.mp4'
    )},`;
    command += `segment_template=${path.join(
      dirPath,
      '$Number$.m4s'
    )},playlist_name=${path.join(
      dirPath,
      'playlist.m3u8'
    )},hls_name=${audioFile.language?.toUpperCase()},hls_group_id=audio' `;
  }

  const subtitleFiles = context.jobs.filter(({ type }) => type === 'subtitle');
  for (let subtitleFile of subtitleFiles) {
    const dirName = path.basename(subtitleFile.fileName, '.vtt');
    const dirPath = path.join(videoDir, dirName);
    const filePath = subtitleFile.fileName;

    command += `'in=${filePath},stream=text,`;
    command += `segment_template=${path.join(
      dirPath,
      '$Number$.vtt'
    )},playlist_name=${path.join(
      dirPath,
      'main.m3u8'
    )},hls_name=${subtitleFile.language?.toUpperCase()},hls_group_id=text' `;
  }

  const videoId = path.basename(videoDir);
  command += `--segment_duration ${duration} --hls_master_playlist_output ${path.resolve(
    videoDir,
    'video.m3u8'
  )} `;
  command += `--hls_base_url ${HLS_BASE_URL}?stream=${videoId}/`;

  return command;
}

async function reduce({ context }: QueueMessage<Job>) {
  const resolutions: { [key: string]: Array<string> } = {};

  context.jobs.forEach(job => {
    if (job.type !== 'video') return;

    const parts = job.fileName.split('_');
    const resolution = parts[parts.length - 2]; // filename_resolution_part.mp4
    resolutions[resolution] = resolutions[resolution] || [];

    resolutions[resolution].push(job.fileName);
  });

  const binary = Executor.getBinary('ffmpeg');
  const dirPath = context.target;

  for (let resolution in resolutions) {
    let content = resolutions[resolution].reduce((acc, filePath) => {
      return acc + 'file ' + path.basename(filePath) + '\n';
    }, '');

    const concatFilePath = path.resolve(dirPath, `${resolution}.txt`);
    fs.writeFileSync(concatFilePath, content);

    const outputFile = path.resolve(dirPath, resolution + '.mp4');
    await Executor.exec(
      `${binary} -y -f concat -i ${concatFilePath} -c copy ${outputFile}`
    );

    resolutions[resolution].forEach(file => {
      fs.unlinkSync(file);
    });

    fs.unlinkSync(concatFilePath);
  }

  const packagerCommand = getSplitCommand(
    dirPath,
    Object.keys(resolutions),
    context
  );
  const packagerBinary = Executor.getBinary('packager');

  await Executor.exec(`${packagerBinary} ${packagerCommand}`);
  await moveThumbnailTracks(context.source, context.target);

  // cleanup
  fs.unlinkSync(context.source);

  for (let resolution in resolutions) {
    fs.unlinkSync(path.resolve(dirPath, `${resolution}.mp4`));
  }

  for (let job of context.jobs) {
    if (['video', 'thumbnail', 'poster'].includes(job.type)) continue;

    const filePath = job.fileName;
    fs.unlinkSync(filePath);
  }
}

async function moveThumbnailTracks(source: string, target: string) {
  const extname = path.extname(source);
  const sourceDir = path.dirname(source);
  const fileName = path.basename(source, extname);

  const sThumbnailName = path.resolve(sourceDir, fileName + '.jpg');
  const sSubtitleTrack = path.resolve(sourceDir, fileName + '.vtt');
  const tThumbnailName = path.resolve(target, fileName + '.jpg');
  const tSubtitleTrack = path.resolve(target, 'thumb.vtt');

  fs.renameSync(sThumbnailName, tThumbnailName);
  fs.renameSync(sSubtitleTrack, tSubtitleTrack);
}

async function start() {
  queueService = await Queue.newBuilder();

  queueService.assert(REDUCE_QUEUE);
  queueService.consume(REDUCE_QUEUE, reduce);
}

function exitHandler() {
  try {
    console.log('Closing connection');
    if (queueService) {
      queueService.disconnect();
    }
  } catch (err) {}

  process.exit();
}

//catches ctrl+c event
process.on('SIGINT', exitHandler);

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler);
process.on('SIGUSR2', exitHandler);

//catches uncaught exceptions
process.on('uncaughtException', function(err) {
  console.log(err);
  exitHandler();
});

const server = http.createServer(function(req, res) {
  switch (req.url) {
    case '/echo':
    case '/_healthz':
      res.write('ok');
      res.end();
      break;
  }
});

start().then(() => server.listen(port));

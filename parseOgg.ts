const oggFile = await Deno.open("target.ogg");

// Build a cache, if the parsing failed further, we simply treat as the content before.
let cache: Uint8Array[] = [];

const read = async (x: Deno.FsFile) => {
  const byte = new Uint8Array(1);
  const result = await x.read(byte);

  if (result === null) {
    throw new Error(`File stream finished parsing`);
  }

  cache.push(byte);

  return byte[0];
};

const readMultiple = async (x: Deno.FsFile, n = 1) => {
  const byte = new Uint8Array(n);
  const result = await x.read(byte);

  if (result === null) {
    throw new Error(`File stream finished parsing`);
  }

  cache.push(byte);

  return byte;
};

const makeCRCTable = () => {
  let c;
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x04c11db7 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
  return crcTable;
};

const crcTable = makeCRCTable();

const crc32 = function (x: Uint8Array) {
  let crc = 0 ^ -1;

  for (let i = 0; i < x.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ x[i]) & 0xff];
  }

  return (crc ^ -1) >>> 0;
};

const getMergedCache = () => {
  const length = cache.reduce((acc, cur) => acc + cur.length, 0);
  const result = new Uint8Array(length);

  let accumulatedLength = 0;
  for (let i = 0; i < cache.length; i += 1) {
    result.set(cache[i], accumulatedLength);
    accumulatedLength += cache[i].length;
  }

  return result;
};

const uInt32Le = (array: Uint8Array) => {
  if (array.length !== 4) {
    throw new Error("Invalid array length. Expected multiple of 4.");
  }

  const dataView = new DataView(array.buffer);

  const float64 = dataView.getUint32(0, true);

  return float64;
};

const uInt64Le = (array: Uint8Array) => {
  if (array.length !== 8) {
    throw new Error("Invalid array length. Expected multiple of 8.");
  }

  const dataView = new DataView(array.buffer);

  const float64 = dataView.getUint32(0, true);

  return float64;
};

const opusHeadMagicSignature = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];
const opusCommentMagicSignature = [
  0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73,
];

interface IOpusChannelMapping {
  streamCount: number;
  coupledCount: number;
  channelMapping: number[];
}

const parseOpusHeader = (array: Uint8Array) => {
  const dataView = new DataView(array.buffer);

  for (let i = 0; i < opusHeadMagicSignature.length; i += 1) {
    if (array[i] !== opusHeadMagicSignature[i]) {
      throw new Error("Invalid magic signature.");
    }
  }

  const version = dataView.getUint8(8);
  const channelCount = dataView.getUint8(9);
  const preSkip = dataView.getUint16(10, true);
  const inputSampleRate = dataView.getUint32(12, true);
  const outputGain = dataView.getUint16(16, true);
  const mappingFamily = dataView.getUint8(18);

  let channelMapping: IOpusChannelMapping | null = null;

  if (array.length > 19) {
    const streamCount = dataView.getUint8(19);
    const coupledCount = dataView.getUint8(20);

    const channelMappings = [];

    for (let i = 0; i < channelCount; i += 1) {
      channelMappings.push(dataView.getUint8(21 + i));
    }

    channelMapping = {
      streamCount,
      coupledCount,
      channelMapping: channelMappings,
    };
  }

  return {
    version,
    channelCount,
    preSkip,
    inputSampleRate,
    outputGain,
    mappingFamily,
    channelMapping,
  };
};

const parseOpusTags = (array: Uint8Array) => {
  const dataView = new DataView(array.buffer);

  for (let i = 0; i < opusCommentMagicSignature.length; i += 1) {
    if (array[i] !== opusCommentMagicSignature[i]) {
      throw new Error("Invalid magic signature.");
    }
  }

  const vendorStringLength = dataView.getInt32(8, true);
  const vendorString = new TextDecoder().decode(
    array.slice(12, 12 + vendorStringLength)
  );

  const userCommentListLength = dataView.getInt32(
    12 + vendorStringLength,
    true
  );

  let commentListLengthLeft = userCommentListLength;
  const userCommentStrings = [];

  while (commentListLengthLeft > 0) {
    const offset = userCommentListLength - commentListLengthLeft;
    const userCommentStringLength = dataView.getInt32(
      12 + vendorStringLength + 4 + offset,
      true
    );
    const userCommentString = new TextDecoder().decode(
      array.slice(
        12 + vendorStringLength + 8 + offset,
        12 + vendorStringLength + 8 + offset + userCommentStringLength
      )
    );

    userCommentStrings.push(userCommentString);

    commentListLengthLeft -= userCommentStringLength + 4;
  }

  return {
    vendorString,
    userCommentString: userCommentStrings,
  };
};

while (true) {
  // read through the file, if we found the pattern of [0x4f, 0x67,0x67,0x53], split it.
  const header0 = await read(oggFile);
  if (header0 !== 0x4f) {
    continue;
  }
  const header1 = await read(oggFile);
  if (header1 !== 0x67) {
    continue;
  }
  const header2 = await read(oggFile);
  if (header2 !== 0x67) {
    continue;
  }
  const header3 = await read(oggFile);
  if (header3 !== 0x53) {
    continue;
  }

  // 4
  const structureVersion = await read(oggFile); // 5
  const headerType = await read(oggFile); // 6

  const isFreshPacket = !(headerType & 0x1);
  const isBos = !!((headerType & 0x2) >>> 1);
  const isBoe = !!((headerType & 0x4) >>> 2);

  const absoluteGranulePosition = await readMultiple(oggFile, 8); // 14
  const streamSerialNumber = await readMultiple(oggFile, 4); // 18
  const pageSequenceNumber = await readMultiple(oggFile, 4); // 22
  const pageChecksum = uInt32Le(await readMultiple(oggFile, 4)); // 26

  const pageRealChecksum = crc32(getMergedCache());

  const checksumPassed = pageChecksum === pageRealChecksum;

  const pageSegments = await read(oggFile); // 27
  const segmentTable = await readMultiple(oggFile, pageSegments); 
  const segments: Uint8Array[] = [];

  for (let i = 0; i < pageSegments; i += 1) {
    segments.push(await readMultiple(oggFile, segmentTable[i]));
  }

  const report = {
    structureVersion,
    headerType: headerType,
    isFreshPacket,
    isBos,
    isBoe,
    absoluteGranulePosition: uInt64Le(absoluteGranulePosition),
    streamSerialNumber: uInt32Le(streamSerialNumber),
    pageSequenceNumber: uInt32Le(pageSequenceNumber),
    pageChecksum,
    pageRealChecksum,
    checksumPassed,
    pageSegments,
    segmentTable,
  };

  console.log(report);

  if (report.pageSequenceNumber === 0) {
    console.log("This is a header page");
    console.log(parseOpusHeader(segments[0]));
  }

  if (report.pageSequenceNumber === 1) {
    console.log("This is a tags page");
    console.log(parseOpusTags(segments[0]));
  }

  
  if (report.pageSequenceNumber === 3) throw new Error(`Stop`);

  cache = [];
}

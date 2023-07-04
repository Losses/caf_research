const textDecoder = new TextDecoder();

const uint = (uint8Array: Uint8Array) => {
  let result = 0;
  const length = uint8Array.length;

  for (let i = 0; i < length; i++) {
    result = (result << 8) + uint8Array[i];
  }

  return result;
};

const float64 = (array: Uint8Array) => {
  if (array.length !== 8) {
    throw new Error("Invalid array length. Expected multiple of 8.");
  }

  const dataView = new DataView(array.buffer);

  const float64 = dataView.getFloat64(0, false); // true indicates little-endian byte order

  return float64;
};

const int64 = (array: Uint8Array) => {
  if (array.length !== 8) {
    throw new Error("Invalid array length. Expected multiple of 8.");
  }

  const dataView = new DataView(array.buffer);

  const float64 = dataView.getBigInt64(0, false);

  return Number(float64);
};

const int32 = (array: Uint8Array) => {
  if (array.length !== 4) {
    throw new Error("Invalid array length. Expected multiple of 8.");
  }

  const dataView = new DataView(array.buffer);

  const float64 = dataView.getInt32(0, false);

  return Number(float64);
};

const packetsTable = (data: Uint8Array) => {
  const numbers: number[] = [];
  let currentNumber = 0;

  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    currentNumber = (currentNumber << 7) | (byte & 0x7f);

    if ((byte & 0x80) === 0) {
      numbers.push(currentNumber);
      currentNumber = 0;
    }
  }

  return numbers;
};

const str = (array: Uint8Array) => {
  return textDecoder.decode(array);
};

export const inspectBinary = (array: Uint8Array) =>
  [...array].map((x) => x.toString(2).padStart(8, "0")).join("");

interface ICAFFileHeader {
  fileType: string;
  fileVersion: number;
  fileFlags: number;
}

const readCafHeader = async (file: Deno.FsFile) => {
  const mFileType = new Uint8Array(4);
  const mFileVersion = new Uint8Array(2);
  const mFileFlags = new Uint8Array(2);

  await file.read(mFileType);
  await file.read(mFileVersion);
  await file.read(mFileFlags);

  const header: ICAFFileHeader = {
    fileType: str(mFileType),
    fileVersion: uint(mFileVersion),
    fileFlags: uint(mFileFlags),
  };

  return header;
};

interface ICAFChunkHeader {
  chunkType: string;
  chunkSize: number;
}

const readChunkHeader = async (file: Deno.FsFile) => {
  const mChunkType = new Uint8Array(4);
  const mChunkSize = new Uint8Array(8);

  await file.read(mChunkType);
  await file.read(mChunkSize);

  const header: ICAFChunkHeader = {
    chunkType: str(mChunkType),
    chunkSize: int64(mChunkSize),
  };

  return header;
};

interface ICAFAudioFormat {
  sampleRate: number;
  formatID: string;
  formatFlags: number;
  bytesPerPacket: number;
  framesPerPacket: number;
  channelsPerFrame: number;
  bitsPerChannel: number;
}

const parseAudioFormat = (uint8Array: Uint8Array) => {
  const mSampleRate = uint8Array.slice(0, 8);
  const mFormatID = uint8Array.slice(8, 12);
  const mFormatFlags = uint8Array.slice(12, 16);
  const mBytesPerPacket = uint8Array.slice(16, 20);
  const mFramesPerPacket = uint8Array.slice(20, 24);
  const mChannelsPerFrame = uint8Array.slice(24, 28);
  const mBitsPerChannel = uint8Array.slice(28, 32);

  const mAudioFormat: ICAFAudioFormat = {
    sampleRate: float64(mSampleRate),
    formatID: str(mFormatID),
    formatFlags: uint(mFormatFlags),
    bytesPerPacket: uint(mBytesPerPacket),
    framesPerPacket: uint(mFramesPerPacket),
    channelsPerFrame: uint(mChannelsPerFrame),
    bitsPerChannel: uint(mBitsPerChannel),
  };

  return mAudioFormat;
};

interface ICAFChannelLayout {
  channelLayoutTag: number;
  channelBitmap: number;
  numberChannelDescriptions: number;
  channelDescriptions: ICAFChannelDescription[];
}

interface ICAFChannelDescription {
  channelLabel: number;
  channelFlags: number;
  coordinates: [number, number, number];
}

const parseChannelDescription = (uint8Array: Uint8Array) => {
  const mChannelLabel = uint8Array.slice(0, 4);
  const mChannelFlags = uint8Array.slice(4, 8);
  const mCoordinates1 = uint8Array.slice(8, 16);
  const mCoordinates2 = uint8Array.slice(16, 24);
  const mCoordinates3 = uint8Array.slice(24, 32);

  const channelDescription: ICAFChannelDescription = {
    channelLabel: uint(mChannelLabel),
    channelFlags: uint(mChannelFlags),
    coordinates: [
      float64(mCoordinates1),
      float64(mCoordinates2),
      float64(mCoordinates3),
    ],
  };

  return channelDescription;
};

const parseChannelLayout = (uint8Array: Uint8Array) => {
  const mChannelLayoutTag = uint8Array.slice(0, 4);
  const mChannelBitmap = uint8Array.slice(4, 8);
  const mNumberChannelDescriptions = uint8Array.slice(8, 12);
  const numberChannelDescriptions = uint(mNumberChannelDescriptions);

  const channelDescriptions = Array(numberChannelDescriptions)
    .fill(0)
    .map((_, i) => {
      const slicedArray = uint8Array.slice(12 + i * 32, 12 + (i + 1) * 32);

      return parseChannelDescription(slicedArray);
    });

  const channelLayout: ICAFChannelLayout = {
    channelLayoutTag: uint(mChannelLayoutTag),
    channelBitmap: uint(mChannelBitmap),
    numberChannelDescriptions,
    channelDescriptions,
  };

  return channelLayout;
};

interface ICAFData {
  editCount: number;
  data: Uint8Array;
}

export const parseData = (uint8Array: Uint8Array) => {
  const mEditCount = uint8Array.slice(0, 4);
  const mData = uint8Array.slice(4);

  const data: ICAFData = {
    editCount: uint(mEditCount),
    data: mData,
  };

  return data;
};

interface ICAFPacketTableHeader {
  numberPackets: number;
  numberValidFrames: number;
  primingFrames: number;
  remainderFrames: number;
}

export const parsePacketTableHeader = (uint8Array: Uint8Array) => {
  const mNumberPackets = uint8Array.slice(0, 8);
  const mNumberValidFrames = uint8Array.slice(8, 16);
  const mPrimingFrames = uint8Array.slice(16, 20);
  const mRemainderFrames = uint8Array.slice(20, 24);

  const parsePacketTableHeader: ICAFPacketTableHeader = {
    numberPackets: int64(mNumberPackets),
    numberValidFrames: int64(mNumberValidFrames),
    primingFrames: int32(mPrimingFrames),
    remainderFrames: int32(mRemainderFrames),
  };

  return parsePacketTableHeader;
};

const parsePacketTable = (Uint8Array: Uint8Array) => {
  const header = Uint8Array.slice(0, 24);
  const body = Uint8Array.slice(24);

  return {
    header: parsePacketTableHeader(header),
    body: packetsTable(body),
  };
};

const readChunk = async (
  file: Deno.FsFile,
  header: ICAFChunkHeader | number
) => {
  const mChunk = new Uint8Array(
    (typeof header === "number" ? header : header.chunkSize) / 8
  );
  await file.read(mChunk);
  return mChunk;
};

const cafFile = await Deno.open("target.caf");

const cafHeader = await readCafHeader(cafFile);
console.log(cafHeader);

while (true) {
  const chunkHeader = await readChunkHeader(cafFile);
  const chunkContent = await readChunk(cafFile, chunkHeader.chunkSize * 8);
  if (chunkHeader.chunkSize === 0) {
    break;
  }
  console.log(chunkHeader);

  if (chunkHeader.chunkType === "desc") {
    const descChunk = parseAudioFormat(chunkContent);
    console.log(descChunk);
  }

  if (chunkHeader.chunkType === "chan") {
    const chanChunk = parseChannelLayout(chunkContent);
    console.log(chanChunk);
  }

  if (chunkHeader.chunkType === "data") {
    const dataChunk = parseData(chunkContent);
    console.log(dataChunk);
  }

  if (chunkHeader.chunkType === "pakt") {
    const paktChunk = parsePacketTable(chunkContent);
    console.log(paktChunk);
  }
}

type SpaceExtend = typeof import("./L0/_all/mod/_core/framework/js/extensions.js").extend;
type SpaceCreateStore = typeof import("./L0/_all/mod/_core/framework/js/AlpineStore.js").createStore;
type SpaceYamlParse = typeof import("./L0/_all/mod/_core/framework/js/yaml-lite.js").parseSimpleYaml;
type SpaceYamlStringify = typeof import("./L0/_all/mod/_core/framework/js/yaml-lite.js").serializeSimpleYaml;
type SpaceMarkdownParseDocument = typeof import("./L0/_all/mod/_core/framework/js/markdown-frontmatter.js").parseMarkdownDocument;
type SpaceMarkdownRender = typeof import("./L0/_all/mod/_core/framework/js/markdown-frontmatter.js").renderMarkdown;

type SpaceApiQueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

type SpaceApiCallOptions = {
  method?: string;
  query?: Record<string, SpaceApiQueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

type SpaceFileApiResult = {
  endpoint?: string;
  recursive?: boolean;
  paths?: string[];
  path: string;
  content?: string;
  encoding?: string;
  bytesWritten?: number;
};

type SpaceFileBatchApiResult = {
  bytesWritten?: number;
  count: number;
  files: SpaceFileApiResult[];
};

type SpacePathBatchApiResult = {
  count: number;
  paths: string[];
};

type SpaceFileReadInput =
  | string
  | {
      encoding?: string;
      path: string;
    };

type SpaceFileReadBatchOptions = {
  encoding?: string;
  files: SpaceFileReadInput[];
};

type SpaceFileWriteInput = {
  content?: string;
  encoding?: string;
  path: string;
};

type SpaceFileWriteBatchOptions = {
  encoding?: string;
  files: SpaceFileWriteInput[];
};

type SpaceFileDeleteInput =
  | string
  | {
      path: string;
    };

type SpaceFileDeleteBatchOptions = {
  paths: SpaceFileDeleteInput[];
};

type SpaceHealthResult = {
  ok: boolean;
  name: string;
  browserAppUrl: string;
  responsibilities: string[];
};

type SpaceUserSelfInfoBackendScope = {
  editable: boolean;
  repoRoots: string[];
};

type SpaceUserSelfInfoFrontendScope = {
  editable: boolean;
  preferredWritableModuleRoots: string[];
  readOnlyLayers: string[];
  readableModuleRoots: string[];
  readableRoots: string[];
  repoRoots: string[];
  writableLayers: string[];
  writableModuleRootPatterns: string[];
  writableModuleRoots: string[];
  writableRootPatterns: string[];
  writableRoots: string[];
};

type SpaceUserSelfInfoScope = {
  backend: SpaceUserSelfInfoBackendScope;
  frontend: SpaceUserSelfInfoFrontendScope;
};

type SpaceUserSelfInfo = {
  fullName: string;
  groups: string[];
  isAdmin: boolean;
  managedGroups: string[];
  scope: SpaceUserSelfInfoScope;
  username: string;
};

type SpaceApi = {
  call<T = unknown>(endpointName: string, callOptions?: SpaceApiCallOptions): Promise<T>;
  fileDelete(path: string): Promise<SpaceFileApiResult>;
  fileDelete(path: SpaceFileDeleteInput): Promise<SpaceFileApiResult>;
  fileDelete(paths: SpaceFileDeleteInput[]): Promise<SpacePathBatchApiResult>;
  fileDelete(options: SpaceFileDeleteBatchOptions): Promise<SpacePathBatchApiResult>;
  fileList(path: string, recursive?: boolean): Promise<SpaceFileApiResult>;
  fileRead(path: string, encoding?: string): Promise<SpaceFileApiResult>;
  fileRead(file: SpaceFileReadInput): Promise<SpaceFileApiResult>;
  fileRead(files: SpaceFileReadInput[], encoding?: string): Promise<SpaceFileBatchApiResult>;
  fileRead(options: SpaceFileReadBatchOptions): Promise<SpaceFileBatchApiResult>;
  fileWrite(path: string, content?: string, encoding?: string): Promise<SpaceFileApiResult>;
  fileWrite(file: SpaceFileWriteInput): Promise<SpaceFileApiResult>;
  fileWrite(files: SpaceFileWriteInput[], encoding?: string): Promise<SpaceFileBatchApiResult>;
  fileWrite(options: SpaceFileWriteBatchOptions): Promise<SpaceFileBatchApiResult>;
  health(): Promise<SpaceHealthResult>;
  userSelfInfo(): Promise<SpaceUserSelfInfo>;
};

type SpaceFw = {
  createStore: SpaceCreateStore;
};

type SpaceYamlUtils = {
  parse: SpaceYamlParse;
  stringify: SpaceYamlStringify;
};

type SpaceMarkdownUtils = {
  render: SpaceMarkdownRender;
  parseDocument: SpaceMarkdownParseDocument;
};

type SpaceChatAttachment = {
  arrayBuffer(): Promise<ArrayBuffer>;
  dataUrl(): Promise<string>;
  file: File | null;
  id: string;
  json(): Promise<any>;
  lastModified: number;
  messageId: string;
  name: string;
  size: number;
  text(): Promise<string>;
  type: string;
};

type SpaceChatAttachments = {
  current(): SpaceChatAttachment[];
  forMessage(messageId: string): SpaceChatAttachment[];
  get(attachmentId: string): SpaceChatAttachment | null;
};

type SpaceChatMessage = {
  attachments: any[];
  content: string;
  id: string;
  kind: string;
  role: "assistant" | "user";
  streaming: boolean;
};

type SpaceChat = {
  attachments: SpaceChatAttachments;
  messages: SpaceChatMessage[];
};

type SpaceUtils = {
  markdown?: SpaceMarkdownUtils;
  yaml?: SpaceYamlUtils;
  [key: string]: any;
};

type SpaceWidgetSize =
  | string
  | [number, number]
  | {
      cols?: number;
      rows?: number;
    };

type SpaceWidgetPosition = {
  col: number;
  row: number;
};

type SpaceWidgetLayoutInput = {
  col?: number;
  cols?: number;
  id?: string;
  position?: Partial<SpaceWidgetPosition>;
  row?: number;
  rows?: number;
  size?: SpaceWidgetSize;
  widgetId?: string;
};

type SpaceWidgetRemovalResult = {
  space: SpaceSpaceRecord;
  widgetIds: string[];
};

type SpaceSpaceRecord = {
  createdAt: string;
  id: string;
  minimizedWidgetIds: string[];
  path: string;
  title: string;
  updatedAt: string;
  widgetIds: string[];
  widgetPositions: Record<string, SpaceWidgetPosition>;
  widgetSizes: Record<string, { cols: number; rows: number }>;
  widgetTitles: Record<string, string>;
};

type SpaceSpacesNamespace = {
  createSpace(options?: {
    id?: string;
    open?: boolean;
    replace?: boolean;
    title?: string;
  }): Promise<SpaceSpaceRecord>;
  createWidgetSource(options?: {
    html?: string;
    size?: SpaceWidgetSize;
    title?: string;
  }): string;
  defineWidget(definition: any): any;
  getCurrentSpace(): SpaceSpaceRecord | null;
  listSpaces(): Promise<Array<SpaceSpaceRecord & { updatedAtLabel: string; widgetCount: number; widgetCountLabel: string }>>;
  openSpace(spaceId: string, options?: { replace?: boolean }): Promise<void>;
  readSpace(spaceId: string): Promise<SpaceSpaceRecord>;
  rearrangeWidgets(options: { spaceId?: string; widgetLayouts?: SpaceWidgetLayoutInput[]; widgets: SpaceWidgetLayoutInput[] }): Promise<SpaceSpaceRecord>;
  reloadCurrentSpace(): Promise<SpaceSpaceRecord>;
  reloadWidget(widgetIdOrOptions: string | { spaceId?: string; widgetId: string }): Promise<SpaceSpaceRecord>;
  removeWidget(options: { spaceId?: string; widgetId: string }): Promise<{ space: SpaceSpaceRecord; widgetId: string }>;
  removeWidgets(options: { spaceId?: string; widgetIds: string[] }): Promise<SpaceWidgetRemovalResult>;
  removeAllWidgets(spaceIdOrOptions?: string | { id?: string; spaceId?: string }): Promise<SpaceWidgetRemovalResult>;
  resolveAppUrl(path: string): string;
  saveSpaceLayout(options: {
    id: string;
    minimizedWidgetIds?: string[];
    widgetIds?: string[];
    widgetPositions?: Record<string, Partial<SpaceWidgetPosition>>;
    widgetSizes?: Record<string, SpaceWidgetSize>;
  }): Promise<SpaceSpaceRecord>;
  saveSpaceMeta(options: { id: string; title?: string }): Promise<SpaceSpaceRecord>;
  sizeToToken(size: SpaceWidgetSize): string;
  toggleWidgets(options: { spaceId?: string; widgetIds: string[] }): Promise<SpaceSpaceRecord>;
  upsertWidget(options: {
    html?: string;
    size?: SpaceWidgetSize;
    source?: string;
    spaceId?: string;
    title?: string | null;
    widgetId?: string;
  }): Promise<{ space: SpaceSpaceRecord; widgetId: string; widgetPath: string }>;
  widgetApiVersion: number;
  [key: string]: any;
};

type SpaceRuntime = {
  api?: SpaceApi;
  chat?: SpaceChat;
  extend: SpaceExtend;
  fw?: SpaceFw;
  spaces?: SpaceSpacesNamespace;
  utils?: SpaceUtils;
  [key: string]: any;
};

declare global {
  var space: SpaceRuntime;

  interface Window {
    space: SpaceRuntime;
  }
}

export {};

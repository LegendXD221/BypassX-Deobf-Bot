const LUA_KEYWORDS = new Set([
  "and",
  "break",
  "continue",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);

const LIBRARY_BASES = new Set(["math", "string", "table", "coroutine", "bit32", "utf8", "debug", "os", "io", "package", "module"]);
const GLOBAL_ALIASES = new Set(["game", "workspace", "script", "shared", "_G", "getgenv", "getfenv", "getrenv", "getreg"]);

const ROBLOX_INSTANCE_KINDS = new Set([
  "Folder", "Model", "Part", "MeshPart", "UnionOperation", "NegateOperation",
  "ScreenGui", "Frame", "TextLabel", "TextButton", "ImageButton", "ImageLabel",
  "ScrollingFrame", "CanvasGroup", "UIListLayout", "UIGridLayout", "UIPadding",
  "UICorner", "UIStroke", "UIGradient", "DropShadow", "VideoFrame", "ViewportFrame",
  "TextBox", "Button", "Slider", "Toggle", "Switch", "Checkbox", "Dropdown",
  "ComboBox", "ProgressBar", "Notification", "Tooltip", "Tab", "TabContainer",
  "Window", "Dialog", "Menu", "PopupMenu", "SidePanel", "AppBar",
  "Sound", "ParticleEmitter", "Beam", "Trail", "Lighting", "BlurEffect",
  "ColorCorrectionEffect", "SunRaysEffect", "DepthOfFieldEffect", "BloomEffect",
  "LocalScript", "ModuleScript", "Configuration", "StringValue", "IntValue",
  "NumberValue", "BoolValue", "ObjectValue", "CFrameValue", "Vector3Value",
  "RemoteEvent", "RemoteFunction", "BindableEvent", "BindableFunction",
  "ClickDetector", "ProximityPrompt", "Tool", "HopperBin", "Seat", "VehicleSeat",
  "Weld", "Snap", "Motor", "Motor6D", "Rotate", "RotateV", "CylindricalConstraint",
  "BallSocketConstraint", "HingeConstraint", "PrismaticConstraint", "RopeConstraint",
  "SpringConstraint", "Plane", "WedgePart", "CornerWedgePart", "TrussPart",
  "SpawnLocation", "Flag", "FlagStand", "Conveyor", "Glue", "Fire", "Smoke",
  "Sparkles", "Explosion", "BodyVelocity", "BodyGyro", "BodyPosition", "BodyForce",
  "RocketPropulsion", "VectorForce", "AlignPosition", "AlignOrientation",
  "Attachment", "Constraint", "Terrain", "TerrainDetail", "Sky", "Clouds",
  "Atmosphere", "Highlight", "SelectionBox", "SelectionSphere", "SurfaceGui",
  "BillboardGui", "Decal", "Texture", "SpecialMesh", "CylinderMesh", "FileMesh",
  "BlockMesh", "PlayerGui", "PlayerScripts", "StarterPack", "StarterPlayer",
  "StarterCharacterScripts", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService",
  "ServerStorage", "Workspace", "Lighting", "SoundService", "Chat", "Teams",
  "CollectionService", "Debris", "MarketplaceService", "TeleportService", "GroupService",
  "BadgeService", "DataStoreService", "MemoryStoreService", "OrderingService",
  "TextService", "TweenService", "RunService", "UserInputService", "GuiService",
  "StarterGui", "Players", "PhysicsService", "PathfindingService", "ContextActionService",
  "InsertService", "Geometry", "TerrainRegion", "WorldRoot", "Camera",
]);

const ROBLOX_CLASS_TO_VAR = {
  ScreenGui: "screenGui",
  Frame: "frame",
  TextLabel: "textLabel",
  TextButton: "textButton",
  ImageButton: "imageButton",
  ImageLabel: "imageLabel",
  ScrollingFrame: "scrollingFrame",
  CanvasGroup: "canvasGroup",
  TextBox: "textBox",
  UICorner: "uiCorner",
  UIStroke: "uiStroke",
  UIGradient: "uiGradient",
  UIListLayout: "uiListLayout",
  UIGridLayout: "uiGridLayout",
  UIPadding: "uiPadding",
  DropShadow: "dropShadow",
  VideoFrame: "videoFrame",
  ViewportFrame: "viewportFrame",
  Sound: "sound",
  ParticleEmitter: "particleEmitter",
  LocalScript: "localScript",
  ModuleScript: "moduleScript",
  RemoteEvent: "remoteEvent",
  RemoteFunction: "remoteFunction",
  BindableEvent: "bindableEvent",
  BindableFunction: "bindableFunction",
  ClickDetector: "clickDetector",
  ProximityPrompt: "proximityPrompt",
  Tool: "tool",
  Folder: "folder",
  Model: "model",
  Part: "part",
  MeshPart: "meshPart",
  Camera: "camera",
  Highlight: "highlight",
  SurfaceGui: "surfaceGui",
  BillboardGui: "billboardGui",
  Decal: "decal",
  Texture: "texture",
  SpecialMesh: "specialMesh",
  Fire: "fire",
  Smoke: "smoke",
  Sparkles: "sparkles",
  Explosion: "explosion",
  Attachment: "attachment",
  Weld: "weld",
  Motor6D: "motor6D",
  PlayerGui: "playerGui",
  BlurEffect: "blurEffect",
  ColorCorrectionEffect: "colorCorrectionEffect",
  BloomEffect: "bloomEffect",
  DepthOfFieldEffect: "depthOfFieldEffect",
  SunRaysEffect: "sunRaysEffect",
  Beam: "beam",
  Trail: "trail",
  Sky: "sky",
  Atmosphere: "atmosphere",
  Clouds: "clouds",
  Terrain: "terrain",
  Configuration: "configuration",
  StringValue: "stringValue",
  IntValue: "intValue",
  NumberValue: "numberValue",
  BoolValue: "boolValue",
  ObjectValue: "objectValue",
  UnionOperation: "union",
  NegateOperation: "negate",
  Seat: "seat",
  VehicleSeat: "vehicleSeat",
  SpawnLocation: "spawnLocation",
  Conveyor: "conveyor",
};

const SERVICE_SHORT_NAMES = {
  Players: "Players",
  ReplicatedStorage: "ReplicatedStorage",
  ReplicatedFirst: "ReplicatedFirst",
  StarterGui: "StarterGui",
  StarterPlayer: "StarterPlayer",
  TweenService: "TweenService",
  UserInputService: "UserInputService",
  RunService: "RunService",
  HttpService: "HttpService",
  TextService: "TextService",
  SoundService: "SoundService",
  Lighting: "Lighting",
  Workspace: "Workspace",
  CollectionService: "CollectionService",
  Debris: "Debris",
  MarketplaceService: "MarketplaceService",
  TeleportService: "TeleportService",
  GroupService: "GroupService",
  BadgeService: "BadgeService",
  DataStoreService: "DataStoreService",
  MemoryStoreService: "MemoryStoreService",
  PathfindingService: "PathfindingService",
  ContextActionService: "ContextActionService",
  InsertService: "InsertService",
  GuiService: "GuiService",
  PhysicsService: "PhysicsService",
  Chat: "Chat",
  Teams: "Teams",
  ServerScriptService: "ServerScriptService",
  ServerStorage: "ServerStorage",
};

const UI_PROPERTY_TO_NAME_HINT = {
  Text: ["textLabel", "textButton", "textBox", "title", "label", "description", "header"],
  Image: ["imageLabel", "imageButton", "icon", "avatar", "thumbnail", "logo", "background"],
  Visible: ["overlay", "popup", "dialog", "modal", "panel"],
  Active: ["button", "toggle", "switch", "interactive"],
  BackgroundColor3: ["background", "panel", "container", "card"],
  BorderSizePixel: ["border", "outline", "separator"],
  ZIndex: ["overlay", "popup", "tooltip", "dropdown"],
  Size: ["container", "wrapper", "panel", "frame"],
  Position: ["container", "wrapper", "panel", "frame"],
  AnchorPoint: ["container", "wrapper", "panel", "frame"],
  Rotation: ["spinner", "indicator", "decoration"],
  CornerRadius: ["roundedFrame", "pill", "badge", "chip"],
  Thickness: ["stroke", "border", "outline", "separator"],
  Color: ["gradient", "accent", "highlight"],
  Transparency: ["fade", "ghost", "shadow"],
  Parent: ["container", "wrapper", "holder"],
  Name: ["namedElement", "tagged"],
};

const VALUE_PROPERTY_NAME_HINTS = {
  Active: "active",
  AnchorPoint: "anchorPoint",
  BackgroundColor3: "backgroundColor3",
  BackgroundTransparency: "backgroundTransparency",
  BorderSizePixel: "borderSizePixel",
  Color: "color",
  CornerRadius: "cornerRadius",
  Font: "font",
  Image: "image",
  Name: "name",
  Parent: "parent",
  PlaceholderText: "placeholderText",
  Position: "position",
  Rotation: "rotation",
  Size: "size",
  Text: "text",
  TextColor3: "textColor3",
  TextSize: "textSize",
  Thickness: "thickness",
  Transparency: "transparency",
  Visible: "visible",
  ZIndex: "zIndex",
};

const EVENT_NAME_HINTS = {
  Changed: "onChanged",
  ChildAdded: "onChildAdded",
  ChildRemoved: "onChildRemoved",
  Heartbeat: "onHeartbeat",
  InputBegan: "onInputBegan",
  InputEnded: "onInputEnded",
  MouseButton1Click: "onClick",
  MouseButton1Down: "onMouseDown",
  MouseButton2Click: "onRightClick",
  MouseEnter: "onMouseEnter",
  MouseLeave: "onMouseLeave",
  MouseMoved: "onMouseMove",
  RenderStepped: "onRenderStep",
  Stepped: "onStepped",
  Focused: "onFocused",
  FocusLost: "onFocusLost",
  Touched: "onTouched",
  TouchTap: "onTap",
  TouchLongPress: "onLongPress",
  AncestryChanged: "onAncestryChanged",
  DescendantAdded: "onDescendantAdded",
  DescendantRemoving: "onDescendantRemoving",
  PropertyChanged: "onPropertyChanged",
  GetPropertyChangedSignal: "onPropertyChanged",
  MouseWheelForward: "onScrollUp",
  MouseWheelBackward: "onScrollDown",
};

function isValidIdentifier(name) {
  return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !LUA_KEYWORDS.has(name);
}

function isObfuscatedLocalName(name) {
  return (
    typeof name === "string" &&
    (
      /^[A-Za-z]$/.test(name) ||
      (/^[A-Za-z]{2}$/.test(name) && !/^(?:cf|dt|dx|dy|id|ui|We|Xe|Ne|Se|Le|Re|Me|Te|Be|Ke|Pe|He|Fe|Ge|Ze|Ce|Ve)$/i.test(name)) ||
      /^(?:arg|local|v)_\d+$/i.test(name) ||
      /^_(?:value|call|p|fn|table)\d*$/i.test(name) ||
      /^var\d+$/i.test(name) ||
      /^_\d+$/.test(name) ||
      /^[a-z]\d{2,}$/.test(name)
    )
  );
}

function toLowerCamel(value) {
  if (!value || typeof value !== "string") return value;
  return value[0].toLowerCase() + value.slice(1);
}

function capitalize(value) {
  if (!value || typeof value !== "string") return value;
  return value[0].toUpperCase() + value.slice(1);
}

function sanitizeName(value) {
  if (!value || typeof value !== "string") return null;
  let sanitized = value.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(sanitized)) sanitized = "_" + sanitized;
  if (LUA_KEYWORDS.has(sanitized)) sanitized = "_" + sanitized;
  return sanitized || null;
}

function unwrapExpression(node) {
  let current = node;
  while (current && current.type === "ParenthesisExpression") {
    current = current.expression;
  }
  return current;
}

function isCallLikeInitializer(node) {
  return (
    Boolean(node) &&
    (
      node.type === "CallExpression" ||
      node.type === "TableCallExpression" ||
      node.type === "StringCallExpression"
    )
  );
}

function createUsageHint() {
  return {
    assignedProperties: [],
    callbackEvents: [],
    className: null,
    instanceCalls: [],
    properties: new Map(),
  };
}

function getUsageHint(hints, name) {
  if (!hints.has(name)) {
    hints.set(name, createUsageHint());
  }
  return hints.get(name);
}

function getIndexPropertyName(node) {
  if (!node || node.type !== "IndexExpression") {
    return null;
  }

  const index = unwrapExpression(node.index);
  if (!index) {
    return null;
  }

  if (index.type === "StringLiteral") {
    return index.value;
  }

  if (index.type === "Identifier") {
    return index.name;
  }

  return null;
}

function getAssignedPropertyInfo(node) {
  const target = unwrapExpression(node);
  if (!target) {
    return null;
  }

  if (target.type === "MemberExpression") {
    return {
      property: target.identifier && target.identifier.name,
      receiver: target.base && target.base.type === "Identifier" ? target.base.name : null,
    };
  }

  if (target.type === "IndexExpression") {
    return {
      property: getIndexPropertyName(target),
      receiver: target.base && target.base.type === "Identifier" ? target.base.name : null,
    };
  }

  return null;
}

function getIdentifierName(node) {
  const target = unwrapExpression(node);
  return target && target.type === "Identifier" ? target.name : null;
}

function buildAssignedPropertyName(receiver, property) {
  if (!property || isObfuscatedLocalName(property) || property.length > 32) {
    return null;
  }

  const suffix = VALUE_PROPERTY_NAME_HINTS[property] || sanitizeName(toLowerCamel(property));
  if (!suffix) {
    return null;
  }

  if (
    receiver &&
    isValidIdentifier(receiver) &&
    !isObfuscatedLocalName(receiver) &&
    receiver.length <= 24 &&
    receiver !== "table" &&
    !suffix.toLowerCase().startsWith(receiver.toLowerCase())
  ) {
    return sanitizeName(`${receiver}${capitalize(suffix)}`);
  }

  return suffix;
}

function buildCallbackName(receiver, eventName) {
  if (!eventName) {
    return null;
  }

  const baseName = EVENT_NAME_HINTS[eventName] || sanitizeName(`on${capitalize(eventName)}`);
  if (!baseName) {
    return null;
  }

  if (receiver && isValidIdentifier(receiver) && !isObfuscatedLocalName(receiver) && receiver.length <= 24) {
    const normalizedBase = baseName.startsWith("on") ? baseName.slice(2) : capitalize(baseName);
    return sanitizeName(`on${capitalize(receiver)}${normalizedBase}`);
  }

  return baseName;
}

function getInstanceClassNameFromInit(init) {
  if (!init || init.type !== "CallExpression") return null;

  const base = init.base;
  if (!base || base.type !== "MemberExpression") return null;

  const isInstanceNew = (
    (base.indexer === "." && base.base && base.base.type === "Identifier" && base.base.name === "Instance" &&
     base.identifier && base.identifier.type === "Identifier" && base.identifier.name === "new") ||
    (base.indexer === ":" && base.base && base.base.type === "Identifier" && base.base.name === "Instance" &&
     base.identifier && base.identifier.type === "Identifier" && base.identifier.name === "new")
  );

  if (!isInstanceNew) return null;

  const firstArg = init.arguments && init.arguments[0];
  if (!firstArg || firstArg.type !== "StringLiteral") return null;

  const className = firstArg.value;
  if (ROBLOX_INSTANCE_KINDS.has(className)) return className;

  const sanitized = sanitizeName(className);
  if (sanitized && sanitized.length > 1 && sanitized.length < 40) return className;

  return null;
}

function getServiceNameFromInit(init) {
  if (!init || init.type !== "CallExpression") return null;

  const base = init.base;
  if (!base || base.type !== "MemberExpression") return null;

  const isGetService = (
    base.indexer === ":" &&
    base.base && base.base.type === "Identifier" && base.base.name === "game" &&
    base.identifier && base.identifier.type === "Identifier" && base.identifier.name === "GetService"
  );

  if (!isGetService) return null;

  const firstArg = init.arguments && init.arguments[0];
  if (!firstArg || firstArg.type !== "StringLiteral") return null;

  return firstArg.value;
}

function getHttpGetUrlFromCall(init) {
  const call = unwrapExpression(init);
  if (!call || call.type !== "CallExpression") return null;

  const base = unwrapExpression(call.base);
  if (!base || base.type !== "MemberExpression") return null;
  if (!base.identifier || (base.identifier.name !== "HttpGet" && base.identifier.name !== "HttpGetAsync")) return null;

  const receiver = unwrapExpression(base.base);
  if (!receiver || receiver.type !== "Identifier" || receiver.name !== "game") return null;

  const firstArg = call.arguments && call.arguments[0];
  return firstArg && firstArg.type === "StringLiteral" ? firstArg.value : null;
}

function getLoadstringHttpGetUrl(initializer) {
  const expression = unwrapExpression(initializer);
  if (!expression || expression.type !== "CallExpression") return null;

  const factory = unwrapExpression(expression.base);
  if (!factory || factory.type !== "CallExpression") return null;
  if (!factory.base || factory.base.type !== "Identifier" || factory.base.name !== "loadstring") return null;

  const source = factory.arguments && factory.arguments[0];
  return getHttpGetUrlFromCall(source);
}

function getMemberAccessFromInit(init) {
  if (!init) return null;
  if (init.type === "MemberExpression") {
    return { base: init.base.name, member: init.identifier.name };
  }
  if (init.type === "IndexExpression" && init.index && init.index.type === "StringLiteral") {
    return { base: init.base.name, member: init.index.value };
  }
  return null;
}

function suggestLocalName(initializer, usageHints = null) {
  initializer = unwrapExpression(initializer);
  if (!initializer) return null;

  const loadstringUrl = getLoadstringHttpGetUrl(initializer);
  if (loadstringUrl) {
    if (/icon|lucide|ui|library|lib/i.test(loadstringUrl)) {
      return "uiLib";
    }
    return "remoteScript";
  }

  const serviceName = getServiceNameFromInit(initializer);
  if (serviceName) {
    if (SERVICE_SHORT_NAMES[serviceName]) return SERVICE_SHORT_NAMES[serviceName];
    return sanitizeName(serviceName);
  }

  const className = getInstanceClassNameFromInit(initializer);
  if (className) {
    const baseName = ROBLOX_CLASS_TO_VAR[className];
    if (baseName) return baseName;
    return sanitizeName(toLowerCamel(className));
  }

  if (initializer.type === "CallExpression") {
    const base = initializer.base;
    if (base && base.type === "MemberExpression") {
      const baseName = base.base && base.base.type === "Identifier" ? base.base.name : null;
      const memberName = base.identifier && base.identifier.name;

      if (memberName === "WaitForChild" && initializer.arguments && initializer.arguments[0] && initializer.arguments[0].type === "StringLiteral") {
        return sanitizeName(toLowerCamel(initializer.arguments[0].value));
      }

      if (memberName === "Clone" && baseName) {
        return baseName + "Clone";
      }

      if (memberName === "Connect") {
        const eventSource = unwrapExpression(base.base);
        if (eventSource && eventSource.type === "MemberExpression" && eventSource.identifier) {
          const receiverName = eventSource.base && eventSource.base.type === "Identifier" ? eventSource.base.name : null;
          const eventName = eventSource.identifier.name;
          const eventBaseName = EVENT_NAME_HINTS[eventName] || sanitizeName(`on${capitalize(eventName)}`) || "connection";
          const normalizedEvent = eventBaseName.startsWith("on") ? eventBaseName.slice(2) : capitalize(eventBaseName);
          const connectionSuffix = `${capitalize(normalizedEvent)}Connection`;
          if (receiverName && isValidIdentifier(receiverName) && !isObfuscatedLocalName(receiverName) && receiverName.length <= 24) {
            return sanitizeName(`${receiverName}${connectionSuffix}`);
          }
          return sanitizeName(toLowerCamel(connectionSuffix));
        }
        return "connection";
      }

      if (memberName === "FindFirstChild" && initializer.arguments && initializer.arguments[0] && initializer.arguments[0].type === "StringLiteral") {
        return sanitizeName(toLowerCamel(initializer.arguments[0].value));
      }

      if (memberName === "CreateWindow") return "window";
      if (memberName === "Colorpicker") return "colorPicker";
      if (memberName === "Paragraph") return "paragraph";
      if (memberName === "Section") return "section";
      if (memberName === "Tab") return "tab";

      if (
        memberName === "UserInputService" &&
        initializer.arguments &&
        initializer.arguments[0] &&
        initializer.arguments[0].type === "StringLiteral"
      ) {
        const iconName = sanitizeName(toLowerCamel(initializer.arguments[0].value));
        return iconName ? `${iconName}Icon` : "icon";
      }

      if (baseName === "UDim2" && memberName === "new") return "udim2";
      if (baseName === "UDim" && memberName === "new") return "udim";
      if (baseName === "Vector2" && memberName === "new") return "vector2";
      if (baseName === "Vector3" && memberName === "new") return "vector3";
      if (baseName === "CFrame" && memberName === "new") return "cframe";
      if (baseName === "Color3" && memberName === "fromRGB") return "color3";
      if (baseName === "Color3" && memberName === "fromHSV") return "color3";
      if (baseName === "Color3" && memberName === "new") return "color3";
      if (baseName === "TweenInfo" && memberName === "new") return "tweenInfo";
      if (baseName === "Ray" && memberName === "new") return "ray";
      if (baseName === "Rect" && memberName === "new") return "rect";
      if (baseName === "Region3" && memberName === "new") return "region3";
      if (baseName === "Faces" && memberName === "new") return "faces";
      if (baseName === "Axes" && memberName === "new") return "axes";
      if (baseName === "NumberSequence" && memberName === "new") return "numberSequence";
      if (baseName === "NumberSequenceKeypoint" && memberName === "new") return "numberSequenceKeypoint";
      if (baseName === "ColorSequence" && memberName === "new") return "colorSequence";
      if (baseName === "ColorSequenceKeypoint" && memberName === "new") return "colorSequenceKeypoint";
      if (baseName === "Font" && memberName === "new") return "font";
      if (baseName === "Font" && memberName === "fromEnum") return "font";
      if (baseName === "Font" && memberName === "fromName") return "font";
      if (baseName === "Random" && memberName === "new") return "random";
    }

    if (base && base.type === "Identifier") {
      if (base.name === "require") return "module";
      if (base.name === "loadstring") return "loadedFunc";
      if (base.name === "cloneTable") return "clonedTable";
      if (base.name === "tick" || base.name === "time") return "timestamp";
      if (base.name === "delay") return "delayedFunc";
      if (base.name === "spawn") return "spawnedFunc";
      if (base.name === "warn") return "warningMsg";
      if (base.name === "print") return "printMsg";
      if (base.name === "type") return "typeResult";
      if (base.name === "typeof") return "typeOfResult";
      if (base.name === "rawget") return "rawValue";
      if (base.name === "rawset") return "rawSetResult";
      if (base.name === "rawequal") return "rawEqualResult";
      if (base.name === "getfenv") return "fenv";
      if (base.name === "setfenv") return "setfenvResult";
      if (base.name === "newproxy") return "proxy";
      if (base.name === "gcinfo") return "gcInfo";
      if (base.name === "collectgarbage") return "gcResult";
    }
  }

  if (initializer.type === "Identifier") {
    if (LIBRARY_BASES.has(initializer.name)) return initializer.name;
    if (GLOBAL_ALIASES.has(initializer.name)) return initializer.name;
  }

  if (initializer.type === "MemberExpression" || initializer.type === "IndexExpression") {
    const base = initializer.base;
    const member =
      initializer.type === "MemberExpression"
        ? initializer.identifier && initializer.identifier.name
        : initializer.index && initializer.index.type === "StringLiteral"
          ? initializer.index.value
          : null;

    if (base && base.type === "Identifier" && member && isValidIdentifier(member) && LIBRARY_BASES.has(base.name)) {
      return `${base.name}${capitalize(member)}`;
    }

    if (base && base.type === "Identifier" && member) {
      return sanitizeName(toLowerCamel(member));
    }
  }

  if (initializer.type === "TableConstructorExpression") {
    return null;
  }

  if (initializer.type === "FunctionDeclaration") {
    return null;
  }

  if (initializer.type === "StringLiteral") {
    return sanitizeName(toLowerCamel(initializer.value));
  }

  if (initializer.type === "NumericLiteral") {
    return "num";
  }

  if (initializer.type === "BooleanLiteral") {
    return "flag";
  }

  if (initializer.type === "UnaryExpression" && initializer.operator === "#") {
    return "length";
  }

  if (initializer.type === "BinaryExpression") {
    const op = initializer.operator;
    if (op === "+" || op === "-" || op === "*" || op === "/" || op === "%" || op === "^" || op === "//") return "result";
    if (op === "..") return "concatenated";
    if (op === "==" || op === "~=" || op === "<" || op === "<=" || op === ">" || op === ">=") return "comparison";
    if (op === "and" || op === "or") return "logicalResult";
  }

  if (initializer.type === "LogicalExpression") {
    return "logicalResult";
  }

  return null;
}

function collectUsageHints(statements, hints = new Map()) {
  for (const stmt of statements) {
    if (!stmt || typeof stmt !== "object") continue;

    if (stmt.type === "AssignmentStatement" && stmt.variables && stmt.variables.length === 1 && stmt.init && stmt.init.length === 1) {
      const variable = stmt.variables[0];
      const init = unwrapExpression(stmt.init[0]);

      if (variable && variable.type === "Identifier" && init) {
        const targetHints = getUsageHint(hints, variable.name);
        const className = getInstanceClassNameFromInit(init);
        if (className) {
          targetHints.className = className;
        }
      }

      const propertyInfo = getAssignedPropertyInfo(variable);
      const sourceName = getIdentifierName(init);
      if (propertyInfo && propertyInfo.property && sourceName) {
        const sourceHints = getUsageHint(hints, sourceName);
        sourceHints.assignedProperties.push(propertyInfo);
      }

      const targetPropertyInfo = getAssignedPropertyInfo(variable);
      if (targetPropertyInfo && targetPropertyInfo.receiver && targetPropertyInfo.property) {
        const targetName = targetPropertyInfo.receiver;
        const propName = targetPropertyInfo.property;

        if (propName && init) {
          const targetHints = getUsageHint(hints, targetName);

          if (init.type === "CallExpression" && init.base) {
            const callBase = init.base;
            if (callBase.type === "MemberExpression" && callBase.base && callBase.base.type === "Identifier" && callBase.base.name === "Instance" && callBase.identifier && callBase.identifier.name === "new") {
              if (init.arguments && init.arguments[0] && init.arguments[0].type === "StringLiteral") {
                targetHints.className = init.arguments[0].value;
              }
            }
            targetHints.instanceCalls.push({ property: propName, call: init });
          }

          if (init.type === "StringLiteral" && typeof init.value === "string") {
            targetHints.properties.set(propName, { type: "string", value: init.value });
          } else if (init.type === "NumericLiteral") {
            targetHints.properties.set(propName, { type: "number", value: init.value });
          } else if (init.type === "BooleanLiteral") {
            targetHints.properties.set(propName, { type: "boolean", value: init.value });
          } else if (init.type === "CallExpression") {
            targetHints.properties.set(propName, { type: "call", call: init });
          }
        }
      }
    }

    if (stmt.type === "LocalStatement" && stmt.variables && stmt.init) {
      const pairCount = Math.min(stmt.variables.length, stmt.init.length);
      for (let index = 0; index < pairCount; index += 1) {
        const variable = stmt.variables[index];
        const init = unwrapExpression(stmt.init[index]);
        if (!variable || variable.type !== "Identifier" || !init) {
          continue;
        }

        const hint = getUsageHint(hints, variable.name);
        const className = getInstanceClassNameFromInit(init);
        if (className) {
          hint.className = className;
        }

        if (
          init.type === "CallExpression" &&
          init.base &&
          init.base.type === "MemberExpression" &&
          init.base.identifier &&
          init.base.identifier.name === "Connect" &&
          init.arguments &&
          init.arguments.length >= 1
        ) {
          const callbackName = getIdentifierName(init.arguments[0]);
          const eventSource = unwrapExpression(init.base.base);
          const eventName = eventSource && eventSource.type === "MemberExpression" && eventSource.identifier
            ? eventSource.identifier.name
            : null;
          const receiverName = eventSource && eventSource.type === "MemberExpression" && eventSource.base && eventSource.base.type === "Identifier"
            ? eventSource.base.name
            : null;

          if (callbackName && eventName) {
            const callbackHints = getUsageHint(hints, callbackName);
            callbackHints.callbackEvents.push({ eventName, receiver: receiverName });
          }
        }
      }
    }

    if (stmt.type === "CallStatement" && stmt.expression && stmt.expression.type === "CallExpression") {
      const expression = stmt.expression;
      const base = expression.base;
      if (
        base &&
        base.type === "MemberExpression" &&
        base.identifier &&
        base.identifier.name === "Connect" &&
        expression.arguments &&
        expression.arguments.length >= 1
      ) {
        const callbackName = getIdentifierName(expression.arguments[0]);
        const eventSource = unwrapExpression(base.base);
        const eventName = eventSource && eventSource.type === "MemberExpression" && eventSource.identifier
          ? eventSource.identifier.name
          : null;
        const receiverName = eventSource && eventSource.type === "MemberExpression" && eventSource.base && eventSource.base.type === "Identifier"
          ? eventSource.base.name
          : null;

        if (callbackName && eventName) {
          const callbackHints = getUsageHint(hints, callbackName);
          callbackHints.callbackEvents.push({ eventName, receiver: receiverName });
        }
      }

      if (
        base &&
        base.type === "MemberExpression" &&
        base.identifier &&
        base.identifier.name === "spawn" &&
        expression.arguments &&
        expression.arguments.length >= 1
      ) {
        const callbackName = getIdentifierName(expression.arguments[0]);
        if (callbackName) {
          const callbackHints = getUsageHint(hints, callbackName);
          callbackHints.callbackEvents.push({ eventName: "Spawn", receiver: "task" });
        }
      }
    }

    if (stmt.type === "IfStatement") {
      stmt.clauses.forEach((clause) => collectUsageHints(clause.body || [], hints));
    } else if (stmt.type === "WhileStatement" || stmt.type === "DoStatement" || stmt.type === "RepeatStatement") {
      collectUsageHints(stmt.body, hints);
    } else if (stmt.type === "FunctionDeclaration") {
      collectUsageHints(stmt.body, hints);
    }
  }
  return hints;
}

function inferNameFromUsageHints(varName, hints) {
  if (!hints) return null;

  if (hints.className) {
    const baseName = ROBLOX_CLASS_TO_VAR[hints.className];
    if (baseName) return baseName;
  }

  if (Array.isArray(hints.callbackEvents) && hints.callbackEvents.length > 0) {
    for (const callbackHint of hints.callbackEvents) {
      const candidate = buildCallbackName(callbackHint.receiver, callbackHint.eventName);
      if (candidate) {
        return candidate;
      }
    }
  }

  if (Array.isArray(hints.assignedProperties) && hints.assignedProperties.length > 0) {
    for (const propertyHint of hints.assignedProperties) {
      const candidate = buildAssignedPropertyName(propertyHint.receiver, propertyHint.property);
      if (candidate) {
        return candidate;
      }
    }
  }

  if (!hints.properties || hints.properties.size === 0) {
    return null;
  }

  const props = [...hints.properties.keys()];

  if (props.includes("Text") && props.includes("TextSize")) return "textLabel";
  if (props.includes("Text") && props.includes("TextColor3")) return "textLabel";
  if (props.includes("Text") && props.includes("Font")) return "textLabel";
  if (props.includes("Text") && props.includes("TextWrapped")) return "textLabel";
  if (props.includes("Image")) return "imageLabel";
  if (props.includes("CornerRadius")) return "uiCorner";
  if (props.includes("Thickness") && props.includes("Color")) return "uiStroke";
  if (props.includes("Visible") && props.includes("ZIndex")) return "overlay";
  if (props.includes("BackgroundColor3") && props.includes("BackgroundTransparency")) return "background";
  if (props.includes("MouseButton1Click") || props.includes("MouseButton1Down")) return "button";
  if (props.includes("Size") && props.includes("Position")) return "frame";
  if (props.includes("Parent")) return "element";
  if (props.includes("Name")) return "namedElement";

  for (const [prop, info] of hints.properties) {
    if (UI_PROPERTY_TO_NAME_HINT[prop]) {
      return UI_PROPERTY_TO_NAME_HINT[prop][0];
    }
  }

  return null;
}

function renameLocals(ast) {
  const usageHints = collectUsageHints(ast.body);
  let changed = false;

  const scopeStack = [];
  const reservedGeneratedNames = new Set();
  const generatedNameCounters = new Map([
    ["callback", 1],
    ["param", 1],
    ["result", 1],
    ["value", 1],
    ["items", 1],
    ["state", 1],
  ]);

  const enterScope = () => {
    scopeStack.push({ declared: new Set(), renames: new Map(), used: new Set() });
  };

  const exitScope = () => {
    scopeStack.pop();
  };

  const isNameUsed = (name) => {
    for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
      if (scopeStack[index].used.has(name)) {
        return true;
      }
    }
    return false;
  };

  const declareName = (original, renamed) => {
    const scope = scopeStack[scopeStack.length - 1];
    let actual = renamed || original;
    const reserveGenerated = typeof renamed === "string" && /^(?:callback|param|result|value|items|state)\d*$/.test(renamed);

    if (renamed) {
      let counter = 1;
      const baseName = renamed;
      while (isNameUsed(actual) || (reserveGenerated && reservedGeneratedNames.has(actual))) {
        actual = `${baseName}${counter}`;
        counter += 1;
      }
    }

    scope.declared.add(original);
    scope.used.add(actual);
    if (reserveGenerated) {
      reservedGeneratedNames.add(actual);
    }
    if (renamed && actual !== original) {
      scope.renames.set(original, actual);
    }
    return actual;
  };

  const resolveName = (name) => {
    for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
      const scope = scopeStack[index];
      if (scope.declared.has(name)) {
        return scope.renames.get(name) || name;
      }
    }
    return name;
  };

  const renameIdentifier = (node) => {
    if (node && node.type === "Identifier") {
      const resolved = resolveName(node.name);
      if (resolved !== node.name) {
        node.name = resolved;
        changed = true;
      }
    }
  };

  const renameExpression = (node) => {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      node.forEach(renameExpression);
      return;
    }

    switch (node.type) {
      case "Identifier":
        renameIdentifier(node);
        return;
      case "MemberExpression":
        renameExpression(node.base);
        return;
      case "IndexExpression":
        renameExpression(node.base);
        renameExpression(node.index);
        return;
      case "CallExpression":
        renameExpression(node.base);
        node.arguments.forEach(renameExpression);
        return;
      case "TableCallExpression":
        renameExpression(node.base);
        renameExpression(node.arguments);
        return;
      case "StringCallExpression":
        renameExpression(node.base);
        renameExpression(node.argument);
        return;
      case "UnaryExpression":
        renameExpression(node.argument);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        renameExpression(node.left);
        renameExpression(node.right);
        return;
      case "ParenthesisExpression":
        renameExpression(node.expression);
        return;
      case "IfExpression":
        renameExpression(node.condition);
        renameExpression(node.trueExpression);
        renameExpression(node.falseExpression);
        return;
      case "TableConstructorExpression":
        node.fields.forEach((field) => {
          if (field.type === "TableValue") {
            renameExpression(field.value);
            return;
          }
          if (field.type === "TableKey") {
            renameExpression(field.key);
            renameExpression(field.value);
            return;
          }
          if (field.type === "TableKeyString") {
            renameExpression(field.value);
          }
        });
        return;
      case "FunctionDeclaration":
        enterScope();
        node.parameters.forEach((param) => {
          if (param.type === "Identifier") {
            const renamed = pickFallbackRename(param.name, "param", null);
            const actual = declareName(param.name, renamed);
            if (actual !== param.name) {
              param.name = actual;
              changed = true;
            }
          }
        });
        renameBlock(node.body, false);
        exitScope();
        return;
      default:
        Object.entries(node).forEach(([key, value]) => {
          if (key === "scope") return;
          renameExpression(value);
        });
    }
  };

  const nextGeneratedName = (prefix) => {
    let counter = generatedNameCounters.get(prefix) || 1;
    let candidate = `${prefix}${counter}`;
    while (isNameUsed(candidate)) {
      counter += 1;
      candidate = `${prefix}${counter}`;
    }
    generatedNameCounters.set(prefix, counter + 1);
    return candidate;
  };

  const isAlwaysErrorReturn = (init) => {
    if (!init || init.type !== "BinaryExpression") return false;
    const numericOps = new Set(["+", "-", "*", "/", "%", "^", "//"]);
    if (!numericOps.has(init.operator)) return false;
    const leftType = init.left && init.left.type;
    const rightType = init.right && init.right.type;
    if ((leftType === "StringLiteral" && rightType === "NumericLiteral") ||
        (leftType === "NumericLiteral" && rightType === "StringLiteral")) return true;
    return false;
  };

  const detectTrashPattern = (init) => {
    if (!init || init.type !== "FunctionDeclaration") return null;
    const body = init.body;
    if (!body || body.length === 0) return "empty";

    if (body.length <= 2) {
      let trashAssign = false;
      let bareReturn = false;
      for (const stmt of body) {
        if (stmt.type === "AssignmentStatement" && stmt.variables.length === 1) {
          const target = stmt.variables[0];
          if (target.type === "IndexExpression" && target.base && target.base.type === "Identifier" && /^[A-Z]$/.test(target.base.name)) {
            trashAssign = true;
          }
        }
        if (stmt.type === "ReturnStatement" && stmt.arguments.length === 0) bareReturn = true;
      }
      if (trashAssign && bareReturn) return "trash-single";
    }

    if (body.length === 1 && body[0].type === "ReturnStatement") {
      for (const arg of body[0].arguments) {
        if (isAlwaysErrorReturn(arg)) return "trash-error";
      }
    }

    return null;
  };

  const pickFallbackRename = (name, kind, initializer = null) => {
    if (!isObfuscatedLocalName(name)) return null;

    if (kind === "function") return nextGeneratedName("callback");
    if (kind === "param") return nextGeneratedName("param");

    const unwrappedInitializer = unwrapExpression(initializer);
    if (unwrappedInitializer && unwrappedInitializer.type === "FunctionDeclaration") {
      return nextGeneratedName("callback");
    }

    if (isCallLikeInitializer(unwrappedInitializer)) {
      const base = unwrappedInitializer.base;

      if (base && base.type === "Identifier" && base.name === "pcall") {
        const pcallArg = unwrappedInitializer.arguments && unwrappedInitializer.arguments[0];
        if (pcallArg && pcallArg.type === "Identifier") {
          const trashPattern = detectTrashPattern(unwrappedInitializer);
          if (trashPattern) return "trashFunction";
        }
        return nextGeneratedName("pcallResult");
      }

      if (base && base.type === "Identifier" && base.name === "loadstring") {
        return "loadedScript";
      }

      if (base && base.type === "Identifier" && base.name === "require") {
        return "module";
      }

      if (base && base.type === "Identifier" && base.name === "spawn") {
        return nextGeneratedName("spawnedFunc");
      }

      if (
        base && base.type === "MemberExpression" &&
        base.identifier &&
        base.identifier.name === "spawn"
      ) {
        return nextGeneratedName("spawnedFunc");
      }

      if (base && base.type === "Identifier" && (base.name === "tostring" || base.name === "tonumber")) {
        const firstArg = unwrappedInitializer.arguments && unwrappedInitializer.arguments[0];
        if (firstArg && firstArg.type === "Identifier") {
          return firstArg.name + "Str";
        }
        return nextGeneratedName("converted");
      }

      if (unwrappedInitializer.type === "FunctionDeclaration") {
        const trashPattern = detectTrashPattern(unwrappedInitializer);
        if (trashPattern) return "trashFunction";
      }

      if (base && base.type === "Identifier") {
        return nextGeneratedName(base.name + "Result");
      }

      return nextGeneratedName("result");
    }

    if (unwrappedInitializer && unwrappedInitializer.type === "TableConstructorExpression") {
      return nextGeneratedName("items");
    }

    return nextGeneratedName("value");
  };

  const pickRename = (initializer, originalName) => {
    const usageHint = usageHints.get(originalName);
    if (usageHint) {
      const inferredName = inferNameFromUsageHints(originalName, usageHint);
      if (inferredName && isValidIdentifier(inferredName)) {
        return inferredName;
      }
    }

    const suggested = suggestLocalName(initializer, usageHints.get(originalName));
    if (suggested && isValidIdentifier(suggested)) {
      return suggested;
    }

    return pickFallbackRename(originalName, "local", initializer);
  };

  const renameStatement = (statement) => {
    if (!statement || typeof statement !== "object") return;

    switch (statement.type) {
      case "LocalStatement":
        statement.init.forEach(renameExpression);
        statement.variables.forEach((variable, index) => {
          if (!variable || variable.type !== "Identifier") return;
          const renamed = pickRename(statement.init[index], variable.name);
          const actual = declareName(variable.name, renamed);
          if (actual !== variable.name) {
            variable.name = actual;
            changed = true;
          }
        });
        return;
      case "AssignmentStatement":
        statement.variables.forEach(renameExpression);
        statement.init.forEach(renameExpression);
        return;
      case "CallStatement":
        renameExpression(statement.expression);
        return;
      case "ReturnStatement":
        statement.arguments.forEach(renameExpression);
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.condition) renameExpression(clause.condition);
          renameBlock(clause.body || [], true);
        });
        return;
      case "WhileStatement":
        renameExpression(statement.condition);
        renameBlock(statement.body, true);
        return;
      case "RepeatStatement":
        renameBlock(statement.body, true);
        renameExpression(statement.condition);
        return;
      case "DoStatement":
        renameBlock(statement.body, true);
        return;
      case "ForNumericStatement":
        renameExpression(statement.start);
        renameExpression(statement.end);
        if (statement.step) renameExpression(statement.step);
        enterScope();
        if (statement.variable && statement.variable.type === "Identifier") {
          const renamed = pickFallbackRename(statement.variable.name, "local", null);
          const actual = declareName(statement.variable.name, renamed);
          if (actual !== statement.variable.name) {
            statement.variable.name = actual;
            changed = true;
          }
        }
        renameBlock(statement.body, false);
        exitScope();
        return;
      case "ForGenericStatement":
        statement.iterators.forEach(renameExpression);
        enterScope();
        statement.variables.forEach((variable) => {
          if (variable.type === "Identifier") {
            const renamed = pickFallbackRename(variable.name, "local", null);
            const actual = declareName(variable.name, renamed);
            if (actual !== variable.name) {
              variable.name = actual;
              changed = true;
            }
          }
        });
        renameBlock(statement.body, false);
        exitScope();
        return;
      case "FunctionDeclaration":
        if (statement.identifier && statement.identifier.type !== "Identifier") {
          renameExpression(statement.identifier);
        }
        if (statement.isLocal && statement.identifier && statement.identifier.type === "Identifier") {
          const renamed = pickFallbackRename(statement.identifier.name, "function", null);
          const actual = declareName(statement.identifier.name, renamed);
          if (actual !== statement.identifier.name) {
            statement.identifier.name = actual;
            changed = true;
          }
        }
        enterScope();
        statement.parameters.forEach((param) => {
          if (param.type === "Identifier") {
            const renamed = pickFallbackRename(param.name, "param", null);
            const actual = declareName(param.name, renamed);
            if (actual !== param.name) {
              param.name = actual;
              changed = true;
            }
          }
        });
        renameBlock(statement.body, false);
        exitScope();
        return;
      default:
        renameExpression(statement);
    }
  };

  const renameBlock = (statements, createScope = true) => {
    if (createScope) enterScope();
    statements.forEach(renameStatement);
    if (createScope) exitScope();
  };

  renameBlock(ast.body, true);
  return { ast, changed };
}

module.exports = {
  renameLocals,
};
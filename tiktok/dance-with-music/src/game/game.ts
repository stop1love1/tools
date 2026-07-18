import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type {
  ActivityEvent,
  ChatEvent,
  GiftEvent,
  LikeEvent,
  LiveUser,
} from "@/shared/live-events";
import { normalizeComment, parseCommand } from "./commands";
import { DEFAULT_RULES, type GameRules } from "./rules";
import {
  ClubLights,
  Confetti,
  DiscoBall,
  DiscoFloor,
  type FloorPattern,
  Fireworks,
  FlameJets,
  GroundFog,
  LedWall,
  LightBeams,
  lerpHue,
  makeGlowTexture,
  PyroDirector,
  SmokeJets,
  SpeakerStack,
  StageBanner,
} from "./effects";
import { InfoScreens, type InfoTrack } from "./info-screens";
import { MusicPlayer } from "./music";
import {
  ALL_DANCE_MOVES,
  GENRE_MOVES,
  pickEnergyMove,
  Player,
  type Beat,
  type DanceMove,
  type MusicGenre,
  type MusicVibe,
} from "./player";
import { NowPlayingScreen } from "./screen";
import {
  generateSkins,
  loadCustomSkins,
  makeLabelTexture,
  type Skin,
} from "./skins";

const FLOOR_W = 28;
const FLOOR_D = 19;
const NEON_MH = [0x25f4ee, 0xfe2c55, 0xffc94d, 0x8a2be2];
const MAX_PLAYERS = 220;
const HYPE_DECAY_PER_S = 0.14;
const DEG_R = Math.PI / 180;
// Khung ngang tham chiếu mà các góc máy được thiết kế (16:9). Khung thực hẹp
// hơn (dọc 9:16) sẽ được nới FOV để giữ nguyên bố cục ngang.
const REF_ASPECT = 16 / 9;
// TikTok không có event "rời live" — user im lặng quá lâu coi như đã thoát
const IDLE_REMOVE_MS = 4 * 60_000;

/**
 * Ép về số hữu hạn. Event từ WebSocket qua JSON.parse KHÔNG được TS đảm bảo
 * đúng kiểu lúc chạy: một trường số thiếu/null biến phép nhân thành NaN. Nếu
 * NaN lọt vào `hype` (biến dùng chung mọi vũ công) thì mọi Math.min/max sau đó
 * đều ra NaN vĩnh viễn → toạ độ nhân vật NaN → sprite bị frustum-cull → MẤT
 * TOÀN BỘ nhân vật trên sàn tới khi reload. Chặn ngay từ biên.
 */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// "Chất" ánh sáng theo thể loại: hue lệch thêm, hệ số năng lượng (tốc độ +
// độ sáng đèn), mức strobe cho phép — ballad ấm dịu không strobe, EDM gắt
const GENRE_LIGHT: Record<
  MusicGenre,
  { hueShift: number; energyMul: number; strobe: number }
> = {
  ballad: { hueShift: 0.02, energyMul: 0.72, strobe: 0.12 },
  pop: { hueShift: 0, energyMul: 1, strobe: 0.6 },
  hiphop: { hueShift: 0.08, energyMul: 0.92, strobe: 0.45 },
  rock: { hueShift: -0.06, energyMul: 1.08, strobe: 0.85 },
  edm: { hueShift: 0.05, energyMul: 1.12, strobe: 1 },
};

// Danh sách góc máy "điện ảnh". drift = biên độ trôi nhẹ quanh vị trí;
// kind = loại khung hình để đạo diễn chọn theo không khí đoạn nhạc.
type CamShot = {
  pos: [number, number, number];
  look: [number, number, number];
  drift: number;
  kind: "wide" | "medium" | "crowd" | "top" | "side" | "close" | "dj" | "low";
};
// Góc toàn cảnh: máy đặt CAO và LÙI XA sau khán đài, nhìn bao trọn sân khấu
// + sàn nhảy + khán đài bậc thang trong một khung (dùng cho chế độ "overview"
// và khi cameraman cắt wide lúc drop). Cao đủ để vượt tường sau khán đài.
const OVERVIEW_SHOT: CamShot = {
  pos: [0, 12.5, 29],
  look: [0, 1.8, -4],
  drift: 0.5,
  kind: "wide",
};
const FRONT_SHOTS: CamShot[] = [
  OVERVIEW_SHOT,
  // Toàn cảnh chính diện — thấy cả khán giả lẫn sân khấu
  { pos: [0, 7, 25], look: [0, 1.7, -3], drift: 0.9, kind: "wide" },
  // Establishing cao-chéo hai phía — bao trọn sân khấu + sàn + đám đông trong
  // một khung sạch, không bị cột/loa che (đứng trong mép sàn, trên cao lùi xa)
  { pos: [-13, 10, 20], look: [1, 1.3, -4], drift: 0.6, kind: "wide" },
  { pos: [13, 10, 20], look: [-1, 1.3, -4], drift: 0.6, kind: "wide" },
  // Chếch trái/phải hạ thấp — có chiều sâu (đủ cao để vượt tường khán đài)
  { pos: [-7, 5.6, 21.5], look: [1.5, 1.8, -3], drift: 0.8, kind: "medium" },
  { pos: [7, 5.6, 21.5], look: [-1.5, 1.8, -3], drift: 0.8, kind: "medium" },
  // POV đám đông NÂNG CAO (trên đầu người) & lùi ra — nhìn lên sân khấu qua
  // biển người, không bị vũ công tiền cảnh che khuất
  { pos: [0, 3.6, 11.5], look: [0, 2, -5], drift: 0.5, kind: "crowd" },
  // Crane chéo góc cao trái/phải nhìn xuống toàn sàn
  { pos: [-11, 13.5, 12], look: [1.5, 0.5, -2], drift: 0.5, kind: "top" },
  { pos: [11, 13.5, 12], look: [-1.5, 0.5, -2], drift: 0.5, kind: "top" },
  // Cánh trái/phải — máy jib đặt HẲN NGOÀI cột truss (x=±16.4) và loa (mép
  // ngoài ±17.25) để KHÔNG bị che; hơi chếch ra trước, ngắm chéo qua sân khấu
  { pos: [-19.5, 5, 6.5], look: [4, 1.7, -5], drift: 0.7, kind: "side" },
  { pos: [19.5, 5, 6.5], look: [-4, 1.7, -5], drift: 0.7, kind: "side" },
  // Cross ngang tầm sân khấu, ra xa thêm nữa — profile hai phía, thoáng cột/loa
  { pos: [-20.5, 4.2, -0.5], look: [4, 2, -6], drift: 0.6, kind: "side" },
  { pos: [20.5, 4.2, -0.5], look: [-4, 2, -6], drift: 0.6, kind: "side" },
  // Góc THẤP ngước lên (hero) — máy đặt ở MÉP TRƯỚC sàn (ít người trước mặt),
  // nhấc lên ~1.7m để nét nhìn vượt đầu vũ công, hắt lên diễn viên trên sân
  // khấu cao (chủ thể ở trên biển người nên không bị che)
  { pos: [0, 1.7, 9], look: [0, 3.4, -9], drift: 0.45, kind: "low" },
  { pos: [-4.5, 1.7, 8.5], look: [1.4, 3.2, -9], drift: 0.45, kind: "low" },
  { pos: [4.5, 1.7, 8.5], look: [-1.4, 3.2, -9], drift: 0.45, kind: "low" },
  // POV của DJ: máy sau bàn DJ trên cao, ngắm CAO hơn (không chúc sát sàn) để
  // bao trọn biển người phía trước cho đẹp, không lấy phải chân/khuất
  { pos: [0, 4.8, -11.5], look: [0, 1.2, 4], drift: 0.4, kind: "dj" },
  // Cận cảnh giữa sàn — khung ngắm bám một vũ công thật, nhưng máy đặt LÙI
  // ra để lấy cả người (không zoom sát mặt), kiểu ống kính trung-cận
  { pos: [-7, 3, 9.5], look: [0, 2, -1], drift: 0.4, kind: "close" },
  { pos: [7.5, 3, 9], look: [0, 2, -1.5], drift: 0.4, kind: "close" },
];
const ORBIT_SHOTS: CamShot[] = [
  ...FRONT_SHOTS,
  // Sát mép sàn nhìn chéo lên sân khấu
  { pos: [-12, 4.2, 1.5], look: [4, 2.1, -6.5], drift: 0.7, kind: "close" },
  { pos: [12, 4.2, 1.5], look: [-4, 2.1, -6.5], drift: 0.7, kind: "close" },
];
// Ống kính theo loại khung — chất điện ảnh: cận cảnh dùng "tele" (FOV hẹp) nén
// hậu cảnh, ấm cúng; toàn cảnh dùng "wide" (FOV rộng) cho hoành tráng
const FOV_BY_KIND: Record<CamShot["kind"], number> = {
  close: 52, // cận cảnh vẫn ấm nhưng không zoom sát mặt nữa
  dj: 50,
  side: 52,
  medium: 56,
  top: 56,
  low: 58, // góc thấp ngước lên — hơi rộng cho hoành tráng
  crowd: 60,
  wide: 62,
};
const STAGE_H = 0.9;
const AUDIENCE_Y = -0.35;
const AUDIENCE_Z0 = FLOOR_D / 2 + 0.5;
// Khán đài dốc bậc thang: mỗi hàng lùi sau cao thêm STEP_H và lùi xa STEP_D
const AUD_STEP_H = 0.42;
const AUD_STEP_D = 1.25;
const AUD_ROWS = 4;

type PodiumSlot = {
  pedestal: THREE.Mesh;
  label: THREE.Sprite;
  pos: THREE.Vector3;
  userId: string | null;
};

type Banner = { sprite: THREE.Sprite; age: number };

export class MemeDanceGame {
  private renderer: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private lastFrameT = performance.now();
  private raf = 0;
  private disposed = false;

  private skins: Skin[] = [];
  private players = new Map<string, Player>();
  private danceSlotsFree: THREE.Vector3[] = [];
  private audienceSlotsFree: THREE.Vector3[] = [];
  private playerSlots = new Map<
    string,
    { zone: "floor" | "audience" | "podium"; pos: THREE.Vector3 }
  >();

  private floor: DiscoFloor;
  private ledWall: LedWall;
  private beams = new LightBeams();
  private ball = new DiscoBall();
  private clubLights = new ClubLights();
  private speakers: SpeakerStack[];
  private fireworks = new Fireworks();
  private confetti = new Confetti();
  // Vành đai pyro BAO QUANH sàn diễn (không dồn về bàn DJ): lửa ở hai đầu
  // mép sân khấu + dọc hai bên sàn nhảy; thứ tự vòi xếp trái → phải để các
  // pattern "đuổi vòng quanh" chạy đúng chiều
  private flames = new FlameJets([
    { x: -FLOOR_W / 2 - 1, y: 0, z: 2 },
    { x: -FLOOR_W / 2 - 1, y: 0, z: -4.5 },
    { x: -9, y: STAGE_H, z: -FLOOR_D / 2 + 2.15 },
    { x: 9, y: STAGE_H, z: -FLOOR_D / 2 + 2.15 },
    { x: FLOOR_W / 2 + 1, y: 0, z: -4.5 },
    { x: FLOOR_W / 2 + 1, y: 0, z: 2 },
  ]);
  private smokeJets = new SmokeJets([
    { x: -11.5, y: STAGE_H, z: -FLOOR_D / 2 + 2.15, tilt: -0.5 },
    { x: 11.5, y: STAGE_H, z: -FLOOR_D / 2 + 2.15, tilt: 0.5 },
    { x: -FLOOR_W / 2 - 1, y: 0, z: -1.5, tilt: -0.4 },
    { x: FLOOR_W / 2 + 1, y: 0, z: -1.5, tilt: 0.4 },
    { x: -FLOOR_W / 2 - 1, y: 0, z: 6.5, tilt: -0.4 },
    { x: FLOOR_W / 2 + 1, y: 0, z: 6.5, tilt: 0.4 },
    // Hai góc TRƯỚC — đặt NGOÀI mép sàn, dưới dải thấp giáp khán giả
    { x: -14, y: AUDIENCE_Y, z: FLOOR_D / 2 + 0.4, tilt: -0.35 },
    { x: 14, y: AUDIENCE_Y, z: FLOOR_D / 2 + 0.4, tilt: 0.35 },
  ]);
  // Dàn sparkular MẶT TIỀN: tia lửa vàng-trắng mảnh đặt NGOÀI sàn nhảy —
  // trên dải thấp ngay sau lan can, phụt gần như liên tục trong điệp khúc
  private frontSparks = new FlameJets(
    [
      { x: -12, y: AUDIENCE_Y, z: FLOOR_D / 2 + 0.4 },
      { x: -6, y: AUDIENCE_Y, z: FLOOR_D / 2 + 0.4 },
      { x: 0, y: AUDIENCE_Y, z: FLOOR_D / 2 + 0.4 },
      { x: 6, y: AUDIENCE_Y, z: FLOOR_D / 2 + 0.4 },
      { x: 12, y: AUDIENCE_Y, z: FLOOR_D / 2 + 0.4 },
    ],
    "spark",
  );
  // "Người chạy pyro" ảo: quyết định bắn pháo hoa/lửa/khói thông minh theo nhạc
  private pyroDirector = new PyroDirector();
  private pyroLastSection = 0; // section beat trước → tính độ leo (buildup)
  // Sương mù mỏng sát sàn, chỉ hiện đoạn trầm/ballad
  private groundFog = new GroundFog(FLOOR_W, FLOOR_D);
  // Bảng tên nghệ thuật khắc vào khung truss (nội dung/phông chỉnh trong settings)
  private stageBanner = new StageBanner(9.5);
  // Cột đèn rọi trời quanh venue — quét chậm trong loop
  private beacons: THREE.Mesh[] = [];
  // Hai màn hình FOH: trái = đang phát, phải = playlist (canvas texture)
  private infoScreens = new InfoScreens(0);
  private ambient!: THREE.AmbientLight;
  private keyLight!: THREE.DirectionalLight;
  private moodColor = new THREE.Color();
  private idleSweepT = 0;
  // Preview/demo chưa phát nhạc: bắn pyro định kỳ để xem trước hiệu ứng
  private showcaseMode = false;
  private showcasePyroT = 0;
  private showcaseFxIdx = 0;
  // Pyro director: đang trong điệp khúc hay không + pattern lửa hiện hành
  private inClimax = false;
  private pyroPattern = 0;
  private blinderMat!: THREE.MeshBasicMaterial;
  private blinderFlash = 0;
  // Lighting director: mức kích hoạt từng nhóm đèn rọi (làm mượt) + "look"
  // đang chạy — verse luân phiên nhóm đèn thay vì bật hết
  private beamAct = 0.5;
  private mhAct = 0.5;
  private clubAct = 0.7;
  private lookMode = 0;
  // Object dùng chung truyền xuống mọi Player mỗi frame (tránh cấp phát mới)
  private vibe: MusicVibe = {
    genre: "pop",
    melodyTrend: 0,
    melodyHeight: 0.5,
    intensity: 0.5,
  };
  // Đồng diễn: cả sàn cùng nhảy theo đội hình (đồng loạt / sóng lan /
  // gọi-đáp 2 nửa / canon so le hàng); kích hoạt khi vào điệp khúc, khi drop,
  // hoặc theo chu kỳ có jitter — không còn vòng lặp mù 32 nhịp.
  private choreoMove: DanceMove | null = null;
  private choreoEndBeat = 0;
  private nextChoreoBeat = 32;
  // Floor director: đổi hoạ tiết sàn theo câu nhạc cho đỡ đơn điệu — verse
  // ưu tiên hoạ tiết dịu, điệp khúc/drop ưu tiên hoạ tiết động
  private nextFloorBeat = 16;
  private lastLoopBeat = -1;
  private lastDropLevel = 0;
  private podium: PodiumSlot[] = [];
  private banners: Banner[] = [];
  private djSprite!: THREE.Sprite;
  // Cả khối sân khấu (bục, bàn DJ, giàn đèn, loa) nhún nhẹ theo nhạc
  private stageGroup = new THREE.Group();
  private boothLeds: THREE.MeshBasicMaterial[] = [];
  private movingHeads: { yoke: THREE.Group; head: THREE.Mesh; dir: number }[] =
    [];
  private movingHeadBeams: THREE.MeshBasicMaterial[] = [];
  // Hướng pan của từng moving head — nhảy sang mốc mới theo mỗi beat
  private mhPan: number[] = [];
  private djLastBeat = -1;
  private djFacing = 1;
  private djFacingCur = 1;
  private djX = 0;
  private djXTarget = 0;
  private djW = 1.7;
  // Order nhạc: user thay NPC trên bàn DJ đến khi đổi bài
  private djTakeover: { userId: string; nickname: string } | null = null;
  private djOrderWaiting: { userId: string; nickname: string } | null = null;
  private djOrdersThisSong = 0;
  private djDefaultMap: THREE.Texture | null = null;
  private djDefaultW = 1.7;
  // DJ "sống": bộ frame đang dùng (đổi theo beat), cú nhảy drop, độ nghiêng
  // người theo đoạn nhạc, và trạng thái scratch đĩa
  private djFrames: THREE.Texture[] = [];
  private djDefaultFrames: THREE.Texture[] = [];
  private djFrame = 0;
  private djJumpT = -1;
  private djLean = 0;
  private djScratchT = -1;
  private djScratchDeck = 0;
  /** HUD gắn handler: user order xong chat bài muốn nghe → thêm vào playlist. */
  onSongRequest: ((nickname: string, query: string) => void) | null = null;
  private djBaseY = 0;
  private decks: THREE.Mesh[] = [];
  private boothParts: THREE.Object3D[] = [];
  private subwooferBoxes: THREE.Object3D[] = [];
  private strobe!: THREE.Mesh;
  private npScreen!: NowPlayingScreen;
  private raycaster = new THREE.Raycaster();
  onScreenControl: ((action: "prev" | "toggle" | "next") => void) | null = null;
  readonly music = new MusicPlayer();
  rules: GameRules = DEFAULT_RULES;
  private hype = 0;

  private focusPlayer: Player | null = null;
  private focusUntil = 0;
  private focusBlend = 0;
  private lookTarget = new THREE.Vector3();
  // Đạo diễn camera: take hiện tại (đếm theo beat), kiểu chuyển cảnh,
  // chuyển động dolly trong take (push-in/slide)
  private shotIdx = 0;
  private prevShotIdx = -1;
  private takeT = 0;
  private takeBeats = 0;
  private takeLen = 16;
  private camLastBeat = -1;
  private camCut = false;
  private camGlide = 0.55;
  private camMoveMode: "push" | "slide" = "push";
  // Chủ thể cận cảnh: vũ công auto camera đang bám khung
  private camSubject: Player | null = null;
  // Admin khóa góc: đạo diễn tự động tạm ngưng, chỉ đổi khi admin bấm
  private cameraLocked = false;
  // Camera tự do (toạ độ cầu) khi admin điều khiển tay — xoay mọi hướng
  private freeCam = false;
  private fcYaw = 0;
  private fcPitch = 0.4;
  private fcRadius = 24;
  private fcTarget = new THREE.Vector3(0, 2, -2);
  private camPos = new THREE.Vector3(0, 12.5, 29);
  private camLook = new THREE.Vector3(0, 1.8, -4);
  private camShotPos = new THREE.Vector3();
  private camShotLook = new THREE.Vector3();
  // Chất điện ảnh: ống kính (FOV) theo loại khung. Giữ khung CHẮC kiểu MV —
  // không nghiêng máy, không rung tay liên tục; động lực đến từ cắt cảnh theo
  // nhịp + punch-zoom theo kick + bám chủ thể thật.
  private camBaseFov = 58;

  private spotlightPlayer: Player | null = null;
  private spotlightUntil = 0;
  // Hàng đầu sát sân khấu: giữ riêng cho top tương tác/donate
  private frontSlots: THREE.Vector3[] = [];
  private frontRow: (Player | null)[] = [];
  private frontSlotSet = new Set<THREE.Vector3>();
  private reseatT = 0;
  private followSpot!: THREE.SpotLight;
  private followSpotTarget = new THREE.Object3D();
  private followBeam!: THREE.Mesh;
  private followBlend = 0;

  private beatIndex = 0;

  private demoTimers: ReturnType<typeof setInterval>[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    // 1.5 là đủ nét cho stream — dpr 2 khiến bloom nặng gấp ~1.8 lần
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene.background = new THREE.Color(0x04050a);
    this.scene.fog = new THREE.Fog(0x04050a, 34, 78);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
    // Camera hạ thấp + lùi ra sau khu khán giả: góc nhìn "người ngoài" thấy
    // được cả hàng khán giả lẫn sân khấu — user mới join thấy ngay nhân vật
    this.camera.position.set(0, 6.2, 23.5);
    this.camera.lookAt(0, 1.8, -2.5);

    this.ambient = new THREE.AmbientLight(0x8890c0, 0.5);
    this.scene.add(this.ambient);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 0.5);
    this.keyLight.position.set(4, 12, 10);
    this.scene.add(this.keyLight);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(1280, 720),
      0.45,
      0.55,
      0.82,
    );
    this.composer.addPass(this.bloom);

    this.scene.add(this.stageGroup);
    this.skins = generateSkins();
    this.preuploadSkins(this.skins);
    this.buildStage();
    this.buildSlots();

    this.floor = new DiscoFloor(FLOOR_W, FLOOR_D, 20, 15);
    // Nhiều ô hơn + cao hơn để phủ kín khung truss sân khấu (ô vuông đều)
    this.ledWall = new LedWall(FLOOR_W + 8, 10.4, -FLOOR_D / 2 - 2.4, 44, 14);
    this.speakers = [
      new SpeakerStack(-FLOOR_W / 2 - 2.1, -3),
      new SpeakerStack(FLOOR_W / 2 + 2.1, -3),
    ];
    this.scene.add(
      this.floor.mesh,
      this.beams.group,
      this.ball.group,
      this.clubLights.group,
      this.fireworks.group,
      this.confetti.points,
      this.flames.group,
      this.smokeJets.group,
      this.frontSparks.group,
      this.groundFog.group,
    );
    this.stageGroup.add(
      this.ledWall.mesh,
      this.speakers[0].group,
      this.speakers[1].group,
    );

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("dblclick", this.onDblClick);

    this.resize();
    this.loop();
  }

  // Kéo chuột để xoay camera mọi hướng; lăn để zoom; nháy đúp về tự động.
  // Click (không kéo) vẫn giữ chức năng bấm màn hình "now playing".
  private dragging = false;
  private dragMoved = false;
  private dragX = 0;
  private dragY = 0;

  private onPointerDown = (e: PointerEvent) => {
    this.dragging = true;
    this.dragMoved = false;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    // Chỉ chế độ Thủ công mới cho kéo chuột xoay camera
    if (this.rules.cameraMode !== "manual") return;
    const dx = e.clientX - this.dragX;
    const dy = e.clientY - this.dragY;
    if (!this.dragMoved && Math.hypot(dx, dy) < 4) return;
    this.dragMoved = true;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    this.orbitCamera(-dx * 0.005, dy * 0.005);
  };

  private onPointerUp = (e: PointerEvent) => {
    const wasDrag = this.dragMoved;
    this.dragging = false;
    this.dragMoved = false;
    if (wasDrag) return; // kéo để xoay — không tính là click
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const hit = this.raycaster.intersectObject(this.npScreen.mesh, false)[0];
    if (!hit?.uv) return;
    const action = this.npScreen.hitTest(hit.uv.x, hit.uv.y);
    if (!action) return;
    if (typeof action === "string") this.onScreenControl?.(action);
    else this.music.seek(action.seek);
  };

  private onWheel = (e: WheelEvent) => {
    // Lăn chuột zoom chỉ trong chế độ Thủ công
    if (this.rules.cameraMode !== "manual") return;
    e.preventDefault();
    this.zoomCamera(Math.sign(e.deltaY) * 2);
  };

  private onDblClick = () => {
    // Nháy đúp trong chế độ Thủ công: đưa camera về khung mặc định
    if (this.rules.cameraMode !== "manual") return;
    this.fcTarget.set(0, 2, -2);
    this.fcYaw = 0;
    this.fcPitch = 0.4;
    this.fcRadius = 24;
  };

  private preuploadSkins(skins: Skin[]) {
    for (const skin of skins) {
      for (const frame of skin.frames) {
        this.renderer.initTexture(frame);
      }
    }
  }

  private buildStage() {
    const floorBase = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_W + 6, FLOOR_D + 6),
      new THREE.MeshStandardMaterial({
        color: 0x0a0c16,
        metalness: 0.2,
        roughness: 0.9,
      }),
    );
    floorBase.rotateX(-Math.PI / 2);
    floorBase.position.y = -0.01;
    this.scene.add(floorBase);

    const space = document.createElement("canvas");
    space.width = 2048;
    space.height = 1024;
    const sctx = space.getContext("2d")!;
    const bgGrad = sctx.createLinearGradient(0, 0, 0, space.height);
    bgGrad.addColorStop(0, "#0a0620");
    bgGrad.addColorStop(0.5, "#120a2e");
    bgGrad.addColorStop(1, "#060418");
    sctx.fillStyle = bgGrad;
    sctx.fillRect(0, 0, space.width, space.height);

    sctx.save();
    sctx.translate(space.width / 2, space.height / 2);
    sctx.rotate(-0.28);
    const milky = sctx.createLinearGradient(0, -190, 0, 190);
    milky.addColorStop(0, "rgba(0,0,0,0)");
    milky.addColorStop(0.35, "rgba(150,130,255,0.16)");
    milky.addColorStop(0.5, "rgba(235,220,255,0.30)");
    milky.addColorStop(0.65, "rgba(120,160,255,0.16)");
    milky.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = milky;
    sctx.fillRect(-space.width, -190, space.width * 2, 380);
    sctx.restore();

    const nebulaColors = [
      "rgba(150,70,255,0.42)",
      "rgba(60,110,255,0.36)",
      "rgba(255,70,170,0.30)",
      "rgba(40,220,235,0.26)",
      "rgba(255,160,80,0.18)",
    ];
    for (let i = 0; i < 22; i++) {
      const x = Math.random() * space.width;
      const y = Math.random() * space.height;
      const r = 120 + Math.random() * 380;
      const grad = sctx.createRadialGradient(x, y, 0, x, y, r);
      const color = nebulaColors[i % nebulaColors.length];
      grad.addColorStop(0, color);
      grad.addColorStop(0.4, color.replace(/[\d.]+\)$/, "0.10)"));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      sctx.fillStyle = grad;
      sctx.fillRect(x - r, y - r, r * 2, r * 2);
    }

    for (let i = 0; i < 2200; i++) {
      const b = Math.random();
      const x = Math.random() * space.width;
      const y = Math.random() * space.height;
      if (b > 0.965) {
        const r = 3 + Math.random() * 6;
        const glow = sctx.createRadialGradient(x, y, 0, x, y, r * 3);
        const hue = [200, 45, 280, 0][Math.floor(Math.random() * 4)];
        glow.addColorStop(0, "rgba(255,255,255,0.95)");
        glow.addColorStop(0.3, `hsla(${hue}, 90%, 75%, 0.5)`);
        glow.addColorStop(1, "rgba(0,0,0,0)");
        sctx.fillStyle = glow;
        sctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
        sctx.strokeStyle = "rgba(255,255,255,0.55)";
        sctx.lineWidth = 1;
        sctx.beginPath();
        sctx.moveTo(x - r * 2.2, y);
        sctx.lineTo(x + r * 2.2, y);
        sctx.moveTo(x, y - r * 2.2);
        sctx.lineTo(x, y + r * 2.2);
        sctx.stroke();
      } else {
        sctx.fillStyle = `rgba(255,255,255,${0.3 + b * 0.7})`;
        const size = b > 0.85 ? 1.8 : 1;
        sctx.fillRect(x, y, size, size);
      }
    }
    const spaceTexture = new THREE.CanvasTexture(space);
    spaceTexture.colorSpace = THREE.SRGBColorSpace;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(90, 40, 24),
      new THREE.MeshBasicMaterial({
        map: spaceTexture,
        side: THREE.BackSide,
        fog: false,
      }),
    );
    this.scene.add(dome);

    const stage = new THREE.Mesh(
      new THREE.BoxGeometry(23, STAGE_H, 4.2),
      new THREE.MeshStandardMaterial({
        color: 0x161a2c,
        metalness: 0.5,
        roughness: 0.5,
      }),
    );
    stage.position.set(0, STAGE_H / 2, -FLOOR_D / 2 + 0.4);
    this.stageGroup.add(stage);

    const lip = new THREE.Mesh(
      new THREE.BoxGeometry(23, 0.06, 0.08),
      new THREE.MeshBasicMaterial({ color: 0xfe2c55 }),
    );
    lip.position.set(0, STAGE_H, -FLOOR_D / 2 + 2.52);
    this.stageGroup.add(lip);

    this.buildGrandstand();

    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(FLOOR_W + 4, 0.05, 0.05),
      new THREE.MeshBasicMaterial({ color: 0x25f4ee }),
    );
    rail.position.set(0, 0.42, FLOOR_D / 2 + 0.15);
    this.scene.add(rail);
    for (let i = -5; i <= 5; i++) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.8),
        new THREE.MeshStandardMaterial({
          color: 0x2a2f45,
          metalness: 0.8,
          roughness: 0.3,
        }),
      );
      post.position.set(i * 2.4, 0.05, FLOOR_D / 2 + 0.15);
      this.scene.add(post);
    }

    const boothZ = -FLOOR_D / 2 + 0.2;
    const booth = new THREE.Mesh(
      new THREE.BoxGeometry(4.6, 1.15, 1.35),
      new THREE.MeshStandardMaterial({
        color: 0x141828,
        metalness: 0.6,
        roughness: 0.4,
      }),
    );
    booth.position.set(0, STAGE_H + 0.575, boothZ);
    const boothTop = new THREE.Mesh(
      new THREE.BoxGeometry(4.9, 0.08, 1.55),
      new THREE.MeshStandardMaterial({
        color: 0x1b2033,
        metalness: 0.7,
        roughness: 0.3,
      }),
    );
    boothTop.position.set(0, STAGE_H + 1.19, boothZ);
    const frontLedMat = new THREE.MeshBasicMaterial({ color: 0x25f4ee });
    const frontLed = new THREE.Mesh(
      new THREE.PlaneGeometry(4.3, 0.7),
      frontLedMat,
    );
    frontLed.position.set(0, STAGE_H + 0.62, boothZ + 0.68);
    this.boothLeds.push(frontLedMat);
    const rimMat = new THREE.MeshBasicMaterial({ color: 0xfe2c55 });
    const rim = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.05, 0.05), rimMat);
    rim.position.set(0, STAGE_H + 1.24, boothZ + 0.775);
    this.stageGroup.add(booth, boothTop, frontLed, rim);
    this.boothParts.push(booth, boothTop, frontLed, rim);

    for (const dx of [-2.35, 2.35]) {
      const barMat = new THREE.MeshBasicMaterial({ color: 0x8a2be2 });
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, 0.12), barMat);
      bar.position.set(dx, STAGE_H + 1.3, boothZ - 0.1);
      this.stageGroup.add(bar);
      this.boothParts.push(bar);
      this.boothLeds.push(barMat);
    }

    const cdjBaseMat = new THREE.MeshStandardMaterial({
      color: 0x10141f,
      metalness: 0.5,
      roughness: 0.5,
    });
    const platterMat = new THREE.MeshStandardMaterial({
      color: 0x2c3350,
      metalness: 0.8,
      roughness: 0.25,
    });
    for (const dx of [-1.45, 1.45]) {
      const cdjBase = new THREE.Mesh(
        new THREE.BoxGeometry(1.05, 0.09, 0.9),
        cdjBaseMat,
      );
      cdjBase.position.set(dx, STAGE_H + 1.275, boothZ);
      const platter = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, 0.05, 28),
        platterMat,
      );
      platter.position.set(dx, STAGE_H + 1.345, boothZ - 0.06);
      const marker = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.02, 0.05),
        new THREE.MeshBasicMaterial({ color: 0x25f4ee }),
      );
      marker.position.set(0.14, 0.03, 0);
      platter.add(marker);
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.06, 16),
        new THREE.MeshBasicMaterial({ color: 0xfe2c55 }),
      );
      hub.position.set(dx, STAGE_H + 1.35, boothZ - 0.06);
      const cue = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.03, 0.1),
        new THREE.MeshBasicMaterial({ color: 0x2ecc71 }),
      );
      cue.position.set(dx - 0.38, STAGE_H + 1.33, boothZ + 0.3);
      this.stageGroup.add(cdjBase, platter, hub, cue);
      this.decks.push(platter);
      this.boothParts.push(cdjBase, platter, hub, cue);
    }

    const mixer = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.1, 0.8),
      new THREE.MeshStandardMaterial({
        color: 0x171c2c,
        metalness: 0.6,
        roughness: 0.4,
      }),
    );
    mixer.position.set(0, STAGE_H + 1.28, boothZ);
    this.stageGroup.add(mixer);
    this.boothParts.push(mixer);
    for (let i = -1; i <= 1; i++) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.02, 0.34),
        new THREE.MeshBasicMaterial({ color: 0x0a0d16 }),
      );
      rail.position.set(i * 0.24, STAGE_H + 1.34, boothZ + 0.14);
      const fader = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.04, 0.07),
        new THREE.MeshBasicMaterial({ color: 0xdfe6ff }),
      );
      fader.position.set(i * 0.24, STAGE_H + 1.35, boothZ + 0.14 - i * 0.08);
      const knob = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 0.05, 12),
        new THREE.MeshBasicMaterial({
          color: [0xfe2c55, 0xffc94d, 0x25f4ee][i + 1],
        }),
      );
      knob.position.set(i * 0.24, STAGE_H + 1.35, boothZ - 0.24);
      this.stageGroup.add(rail, fader, knob);
      this.boothParts.push(rail, fader, knob);
    }
    const riser = new THREE.Mesh(
      new THREE.BoxGeometry(5.6, 0.22, 2.9),
      new THREE.MeshStandardMaterial({
        color: 0x0d1020,
        metalness: 0.55,
        roughness: 0.45,
      }),
    );
    riser.position.set(0, STAGE_H + 0.11, boothZ + 0.3);
    const riserLedMat = new THREE.MeshBasicMaterial({ color: 0x25f4ee });
    const riserLed = new THREE.Mesh(
      new THREE.BoxGeometry(5.6, 0.05, 0.05),
      riserLedMat,
    );
    riserLed.position.set(0, STAGE_H + 0.22, boothZ + 0.3 + 1.45);
    this.boothLeds.push(riserLedMat);
    this.stageGroup.add(riser, riserLed);

    const lipLedMat = new THREE.MeshBasicMaterial({
      color: 0x25f4ee,
      transparent: true,
      opacity: 0.9,
    });
    const lipLed = new THREE.Mesh(new THREE.PlaneGeometry(22.6, 0.42), lipLedMat);
    lipLed.position.set(0, 0.45, -FLOOR_D / 2 + 2.51);
    this.boothLeds.push(lipLedMat);
    this.stageGroup.add(lipLed);

    const wedgeMat = new THREE.MeshStandardMaterial({
      color: 0x14161f,
      metalness: 0.3,
      roughness: 0.7,
    });
    for (const dx of [-1.9, 1.9]) {
      const wedge = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.42, 0.7), wedgeMat);
      wedge.position.set(dx, STAGE_H + 0.24, boothZ + 1.9);
      wedge.rotation.x = 0.45;
      this.stageGroup.add(wedge);
    }

    const arrayBoxMat = new THREE.MeshStandardMaterial({
      color: 0x171a26,
      metalness: 0.45,
      roughness: 0.6,
    });
    const arrayGrillMat = new THREE.MeshStandardMaterial({
      color: 0x272d42,
      metalness: 0.7,
      roughness: 0.3,
    });
    for (const dx of [-11, 11]) {
      const cable = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 1),
        new THREE.MeshBasicMaterial({ color: 0x333a55 }),
      );
      cable.position.set(dx, 11.35, -FLOOR_D / 2 + 1.4);
      this.stageGroup.add(cable);
      for (let i = 0; i < 6; i++) {
        const box = new THREE.Mesh(
          new THREE.BoxGeometry(1.7, 0.52, 1.15),
          arrayBoxMat,
        );
        box.position.set(dx, 10.7 - i * 0.56, -FLOOR_D / 2 + 1.5 + i * 0.12);
        box.rotation.x = i * 0.09;
        this.stageGroup.add(box);
        const grill = new THREE.Mesh(
          new THREE.PlaneGeometry(1.52, 0.38),
          arrayGrillMat,
        );
        grill.position.set(dx, 10.7 - i * 0.56, -FLOOR_D / 2 + 2.09 + i * 0.12);
        grill.rotation.x = i * 0.09;
        this.stageGroup.add(grill);
      }
      const arrayLedMat = new THREE.MeshBasicMaterial({ color: 0xfe2c55 });
      const arrayLed = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 0.05, 0.05),
        arrayLedMat,
      );
      arrayLed.position.set(dx, 7.7, -FLOOR_D / 2 + 2.2);
      this.boothLeds.push(arrayLedMat);
      this.stageGroup.add(arrayLed);
    }

    const frontTrussMat = new THREE.MeshStandardMaterial({
      color: 0x262c44,
      metalness: 0.85,
      roughness: 0.35,
    });
    for (const x of [-(FLOOR_W / 2 + 2.4), FLOOR_W / 2 + 2.4]) {
      const tower = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 12, 0.4),
        frontTrussMat,
      );
      tower.position.set(x, 6, 6.5);
      this.stageGroup.add(tower);
    }
    const frontBar = new THREE.Mesh(
      new THREE.BoxGeometry(FLOOR_W + 5.2, 0.35, 0.35),
      frontTrussMat,
    );
    frontBar.position.set(0, 11.8, 6.5);
    this.stageGroup.add(frontBar);
    const frontParColors = [0x25f4ee, 0xffc94d, 0xfe2c55, 0x8a2be2];
    for (let i = 0; i < 9; i++) {
      const par = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 0.45, 0.35),
        new THREE.MeshBasicMaterial({
          color: frontParColors[i % frontParColors.length],
        }),
      );
      par.position.set((i - 4) * (FLOOR_W / 9), 11.45, 6.5);
      this.stageGroup.add(par);
    }

    // Dàn blinder trắng ấm trên truss mặt tiền — chớp thẳng về phía khán
    // giả/camera ở phách 1 điệp khúc, đặc sản concert thật
    this.blinderMat = new THREE.MeshBasicMaterial({
      color: 0xffe3b8,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    for (let i = 0; i < 5; i++) {
      const blinder = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 16),
        this.blinderMat,
      );
      blinder.position.set((i - 2) * 5.5, 11.1, 6.7);
      this.stageGroup.add(blinder);
    }

    const headBodyMat = new THREE.MeshStandardMaterial({
      color: 0x1c2136,
      metalness: 0.7,
      roughness: 0.35,
    });
    const beamGeoMh = new THREE.ConeGeometry(0.55, 11.5, 14, 1, true);
    beamGeoMh.translate(0, -5.75, 0);
    const mhSpots: Array<[number, number]> = [
      [-8, 6.5],
      [8, 6.5],
      [0, -FLOOR_D / 2 + 1.2],
    ];
    mhSpots.forEach(([x, z], i) => {
      const yoke = new THREE.Group();
      yoke.position.set(x, 11.55, z);
      const mount = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.16, 0.22),
        headBodyMat,
      );
      const head = new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.17, 0.45, 12),
        headBodyMat,
      );
      head.position.y = -0.38;
      const beamMat = new THREE.MeshBasicMaterial({
        color: NEON_MH[i % NEON_MH.length],
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const beam = new THREE.Mesh(beamGeoMh, beamMat);
      beam.position.y = -0.2;
      head.add(beam);
      this.movingHeadBeams.push(beamMat);
      yoke.add(mount, head);
      this.stageGroup.add(yoke);
      // Truss sau (z âm) phải nghiêng NGƯỢC lại để chiếu về phía sàn nhảy
      this.movingHeads.push({ yoke, head, dir: z < 0 ? -1 : 1 });
    });

    // Neo DJ tại CHÂN như Player — đứng trên bục sau bàn, không còn cảnh
    // nửa người chìm xuyên qua mặt bàn khi camera nhìn từ trên cao
    this.djBaseY = STAGE_H + 0.55;
    this.djSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.skins[3 % this.skins.length].frames[0],
        transparent: true,
      }),
    );
    this.djSprite.center.set(0.5, 0);
    this.djSprite.material.color.setScalar(0.72);
    this.djSprite.scale.set(1.7, 2.125, 1);
    this.djSprite.position.set(0, this.djBaseY, -FLOOR_D / 2 - 0.5);
    this.djDefaultMap = this.skins[3 % this.skins.length].frames[0];
    this.djDefaultFrames = this.skins[3 % this.skins.length].frames;
    this.djFrames = this.djDefaultFrames;
    this.djDefaultW = 1.7;
    this.stageGroup.add(this.djSprite);

    this.npScreen = new NowPlayingScreen(
      9.5,
      3,
      new THREE.Vector3(0, 6.6, -FLOOR_D / 2 - 2.35),
    );
    this.stageGroup.add(this.npScreen.mesh);

    this.strobe = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 3.6),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.strobe.position.set(0, STAGE_H + 2, -FLOOR_D / 2 - 1.4);
    this.stageGroup.add(this.strobe);

    this.followSpot = new THREE.SpotLight(0xfff2cf, 0, 45, Math.PI / 12, 0.5, 1.2);
    this.followSpot.position.set(0, 12.5, 3);
    this.followSpot.target = this.followSpotTarget;
    const beamGeo = new THREE.ConeGeometry(0.85, 12, 20, 1, true);
    beamGeo.translate(0, -6, 0);
    this.followBeam = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({
        color: 0xfff6dd,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.followBeam.position.copy(this.followSpot.position);
    this.followBeam.visible = false;
    this.scene.add(this.followSpot, this.followSpotTarget, this.followBeam);

    const trussMat = new THREE.MeshStandardMaterial({
      color: 0x262c44,
      metalness: 0.85,
      roughness: 0.35,
    });
    for (const x of [-(FLOOR_W / 2 + 2.4), FLOOR_W / 2 + 2.4]) {
      const tower = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 12, 0.4),
        trussMat,
      );
      tower.position.set(x, 6, -FLOOR_D / 2 + 1.2);
      this.stageGroup.add(tower);
    }
    const topBar = new THREE.Mesh(
      new THREE.BoxGeometry(FLOOR_W + 5.2, 0.35, 0.35),
      trussMat,
    );
    topBar.position.set(0, 11.8, -FLOOR_D / 2 + 1.2);
    this.stageGroup.add(topBar);

    // Bảng tên khắc vào thanh truss ngang, quay ra khán giả — ngồi khớp trên
    // thanh khung thay vì lơ lửng phía trên
    this.stageBanner.mesh.position.set(0, 12.4, -FLOOR_D / 2 + 1.4);
    this.stageGroup.add(this.stageBanner.mesh);

    const parColors = [0xfe2c55, 0x25f4ee, 0xffc94d, 0x8a2be2];
    for (let i = 0; i < 9; i++) {
      const par = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 0.45, 0.35),
        new THREE.MeshBasicMaterial({ color: parColors[i % parColors.length] }),
      );
      par.position.set((i - 4) * (FLOOR_W / 9), 11.45, -FLOOR_D / 2 + 1.2);
      this.stageGroup.add(par);
    }

    for (const x of [-8, -4, 0, 4, 8]) {
      const sub = new THREE.Mesh(
        new THREE.BoxGeometry(2.9, 1.15, 1.05),
        new THREE.MeshStandardMaterial({
          color: 0x101322,
          metalness: 0.4,
          roughness: 0.7,
        }),
      );
      sub.position.set(x, 0.58, -FLOOR_D / 2 + 2.95);
      this.stageGroup.add(sub);
      this.subwooferBoxes.push(sub);
    }

    this.loadStageModels();
    this.buildEnvironment();

    const podiumColors = [0xffc94d, 0xc0c8d8, 0xcd7f52];
    const podiumHeights = [2.0, 1.5, 1.15];
    const podiumX = [-3.8, 3.8, 6.6];
    const podiumZ = -FLOOR_D / 2 + 0.9;
    for (let i = 0; i < 3; i++) {
      const pedestal = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, podiumHeights[i], 1.9),
        new THREE.MeshStandardMaterial({
          color: podiumColors[i],
          metalness: 0.7,
          roughness: 0.3,
        }),
      );
      pedestal.position.set(
        podiumX[i],
        STAGE_H + podiumHeights[i] / 2,
        podiumZ,
      );

      const label = new THREE.Sprite(
        new THREE.SpriteMaterial({ transparent: true, opacity: 0 }),
      );
      label.position.set(
        podiumX[i],
        STAGE_H + podiumHeights[i] + 2.35,
        podiumZ,
      );

      this.scene.add(pedestal, label);
      this.podium.push({
        pedestal,
        label,
        pos: new THREE.Vector3(
          podiumX[i],
          STAGE_H + podiumHeights[i],
          podiumZ,
        ),
        userId: null,
      });
    }
  }

  /**
   * Cảnh quan quanh sân khấu: skyline thành phố sáng đèn bọc vòng phía xa,
   * hành tinh có vành trên trời, cổng neon ôm tường LED, tháp LED cánh gà
   * và viền neon dọc sàn — các dải LED đẩy vào boothLeds để đổi màu theo nhạc.
   */
  private buildEnvironment() {
    // --- Phông hậu đặc sau sân khấu: chắn không cho nhìn xuyên thấu vào
    // trong khi xoay camera ra phía sau (tường LED chỉ có 1 mặt) ---
    const backdropMat = new THREE.MeshStandardMaterial({
      color: 0x0a0c16,
      metalness: 0.4,
      roughness: 0.8,
      side: THREE.DoubleSide,
    });
    const backdrop = new THREE.Mesh(
      new THREE.BoxGeometry(FLOOR_W + 12, 14, 0.6),
      backdropMat,
    );
    backdrop.position.set(0, 6, -FLOOR_D / 2 - 3.2);
    this.scene.add(backdrop);
    // Hai cánh gà hông + trần che khe hở hai bên/đỉnh khi nhìn chếch từ sau
    for (const sx of [-1, 1]) {
      const wing = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 14, 10),
        backdropMat,
      );
      wing.position.set(sx * (FLOOR_W / 2 + 5.7), 6, -FLOOR_D / 2 + 1.5);
      this.scene.add(wing);
    }
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(FLOOR_W + 12, 0.6, 10),
      backdropMat,
    );
    roof.position.set(0, 12.7, -FLOOR_D / 2 + 1.5);
    this.scene.add(roof);

    // --- Skyline thành phố: silhouette nhà cao tầng + cửa sổ sáng ---
    const city = document.createElement("canvas");
    city.width = 2048;
    city.height = 256;
    const cctx = city.getContext("2d")!;
    const glow = cctx.createLinearGradient(0, 110, 0, 256);
    glow.addColorStop(0, "rgba(0,0,0,0)");
    glow.addColorStop(1, "rgba(110,70,170,0.35)");
    cctx.fillStyle = glow;
    cctx.fillRect(0, 0, city.width, city.height);
    let bx = 0;
    while (bx < city.width) {
      const bw = 30 + Math.random() * 70;
      const bh = 50 + Math.random() * 150;
      cctx.fillStyle = "#080a14";
      cctx.fillRect(bx, city.height - bh, bw, bh);
      cctx.fillStyle = Math.random() < 0.5 ? "#ffd9a0" : "#9fd8ff";
      for (let wy = city.height - bh + 6; wy < city.height - 8; wy += 9) {
        for (let wx = bx + 4; wx < bx + bw - 4; wx += 8) {
          if (Math.random() < 0.16) cctx.fillRect(wx, wy, 2.5, 3.5);
        }
      }
      bx += bw + 2 + Math.random() * 14;
    }
    const cityTexture = new THREE.CanvasTexture(city);
    cityTexture.colorSpace = THREE.SRGBColorSpace;
    const skyline = new THREE.Mesh(
      new THREE.CylinderGeometry(66, 66, 15, 48, 1, true),
      new THREE.MeshBasicMaterial({
        map: cityTexture,
        transparent: true,
        side: THREE.BackSide,
        fog: false,
      }),
    );
    skyline.position.y = 6.5;
    this.scene.add(skyline);

    // --- Hành tinh có vành — điểm nhấn bầu trời ---
    const pc = document.createElement("canvas");
    pc.width = pc.height = 64;
    const pctx = pc.getContext("2d")!;
    const pGrad = pctx.createRadialGradient(24, 22, 4, 32, 32, 34);
    pGrad.addColorStop(0, "#7d95d8");
    pGrad.addColorStop(0.6, "#3a4f8e");
    pGrad.addColorStop(1, "#1c2749");
    pctx.fillStyle = pGrad;
    pctx.fillRect(0, 0, 64, 64);
    const planetTexture = new THREE.CanvasTexture(pc);
    planetTexture.colorSpace = THREE.SRGBColorSpace;
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(5.5, 24, 16),
      new THREE.MeshBasicMaterial({ map: planetTexture, fog: false }),
    );
    planet.position.set(-30, 27, -58);
    const planetRing = new THREE.Mesh(
      new THREE.RingGeometry(7, 10.5, 48),
      new THREE.MeshBasicMaterial({
        color: 0x8a9cff,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    planetRing.position.copy(planet.position);
    planetRing.rotation.x = 1.25;
    planetRing.rotation.y = 0.35;
    this.scene.add(planet, planetRing);

    // --- Cổng neon ôm quanh tường LED — đổi màu theo nhạc ---
    const archMat = new THREE.MeshBasicMaterial({ color: 0x25f4ee });
    const archW = FLOOR_W + 9.5;
    const archZ = -FLOOR_D / 2 - 2.45;
    for (const dx of [-archW / 2, archW / 2]) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 9, 0.18),
        archMat,
      );
      post.position.set(dx, 5.7, archZ);
      this.stageGroup.add(post);
    }
    const archTop = new THREE.Mesh(
      new THREE.BoxGeometry(archW + 0.2, 0.18, 0.18),
      archMat,
    );
    archTop.position.set(0, 10.25, archZ);
    this.stageGroup.add(archTop);
    this.boothLeds.push(archMat);

    // --- Hai tháp LED cánh gà đóng khung sân khấu ---
    const towerDark = new THREE.MeshStandardMaterial({
      color: 0x151928,
      metalness: 0.6,
      roughness: 0.5,
    });
    for (const sx of [-1, 1]) {
      const x = sx * (FLOOR_W / 2 + 3.8);
      const tower = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 9.5, 1.7),
        towerDark,
      );
      tower.position.set(x, 4.75, -7);
      this.stageGroup.add(tower);
      const stripMat = new THREE.MeshBasicMaterial({ color: 0x8a2be2 });
      for (const off of [-0.55, 0, 0.55]) {
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(0.14, 8.8, 0.14),
          stripMat,
        );
        strip.position.set(x + off, 4.75, -7 + 0.93);
        this.stageGroup.add(strip);
      }
      this.boothLeds.push(stripMat);
    }

    // --- Viền neon chạy dọc hai mép sàn nhảy ---
    const rimMat = new THREE.MeshBasicMaterial({ color: 0xfe2c55 });
    for (const sx of [-1, 1]) {
      const rim = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.06, FLOOR_D + 0.4),
        rimMat,
      );
      rim.position.set(sx * (FLOOR_W / 2 + 0.4), 0.05, 0);
      this.scene.add(rim);
    }
    this.boothLeds.push(rimMat);

    // --- Mặt đất bê tông trải tới chân skyline — venue không còn lơ lửng ---
    const ground = document.createElement("canvas");
    ground.width = ground.height = 256;
    const gctx = ground.getContext("2d")!;
    const gGrad = gctx.createRadialGradient(128, 128, 20, 128, 128, 128);
    gGrad.addColorStop(0, "#0d0f16");
    gGrad.addColorStop(0.55, "#090b12");
    gGrad.addColorStop(1, "#04050a");
    gctx.fillStyle = gGrad;
    gctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 500; i++) {
      gctx.fillStyle = `rgba(255,255,255,${0.015 + Math.random() * 0.03})`;
      gctx.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
    }
    const groundTexture = new THREE.CanvasTexture(ground);
    groundTexture.colorSpace = THREE.SRGBColorSpace;
    const groundMesh = new THREE.Mesh(
      new THREE.CircleGeometry(66, 48),
      new THREE.MeshBasicMaterial({ map: groundTexture }),
    );
    groundMesh.rotateX(-Math.PI / 2);
    groundMesh.position.y = -0.03;
    this.scene.add(groundMesh);

    // --- Dây rigging võng từ truss xuống tháp/tường LED như venue thật ---
    const cableMat = new THREE.MeshBasicMaterial({ color: 0x272d42 });
    const cableSpecs: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [
      [
        new THREE.Vector3(-8, 11.8, -8.3),
        new THREE.Vector3(-13, 10, -10),
        new THREE.Vector3(-17.5, 9.3, -11.7),
      ],
      [
        new THREE.Vector3(8, 11.8, -8.3),
        new THREE.Vector3(13, 10, -10),
        new THREE.Vector3(17.5, 9.3, -11.7),
      ],
      [
        new THREE.Vector3(-4, 11.8, 6.5),
        new THREE.Vector3(-9, 10.2, -0.5),
        new THREE.Vector3(-13.9, 9.6, -7),
      ],
      [
        new THREE.Vector3(4, 11.8, 6.5),
        new THREE.Vector3(9, 10.2, -0.5),
        new THREE.Vector3(13.9, 9.6, -7),
      ],
    ];
    for (const [a, b, c] of cableSpecs) {
      const curve = new THREE.QuadraticBezierCurve3(a, b, c);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 12, 0.035, 5),
        cableMat,
      );
      this.stageGroup.add(tube);
    }

    // --- Tháp FOH (bàn điều khiển âm thanh/ánh sáng) sau khán đài ---
    const fohMat = new THREE.MeshStandardMaterial({
      color: 0x1a1f30,
      metalness: 0.6,
      roughness: 0.5,
    });
    const foh = new THREE.Group();
    const fohBase = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.18, 2.6), fohMat);
    fohBase.position.y = 1.1;
    foh.add(fohBase);
    const fohPostGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.4);
    for (const [px, pz] of [
      [-1.6, -1.2],
      [1.6, -1.2],
      [-1.6, 1.2],
      [1.6, 1.2],
    ]) {
      const post = new THREE.Mesh(fohPostGeo, fohMat);
      post.position.set(px, 1.2, pz);
      foh.add(post);
    }
    const desk = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 0.9), fohMat);
    desk.position.set(0, 1.45, -0.4);
    foh.add(desk);
    foh.position.set(0, 0, 16.8);
    this.scene.add(foh);
    // Hai màn hình đặt ngay trên bàn FOH (giữ nguyên vị trí quen thuộc)
    this.infoScreens.group.position.set(0, 0, 18.0);
    this.scene.add(this.infoScreens.group);

    // --- Dây đèn bóng ấm giăng trên cột quanh venue — chất hội chợ đêm ---
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x232838,
      metalness: 0.5,
      roughness: 0.6,
    });
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 4.6);
    const bulbPos: number[] = [];
    const addString = (a: THREE.Vector3, b: THREE.Vector3) => {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y -= 1.1;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      for (let k = 0; k <= 16; k++) {
        const p = curve.getPoint(k / 16);
        bulbPos.push(p.x, p.y, p.z);
      }
    };
    const poleTops: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) {
      for (const [x, z] of [
        [19, 12],
        [21.5, 0],
        [19, -12],
      ]) {
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(sx * x, 2.3, z);
        this.scene.add(pole);
        poleTops.push(new THREE.Vector3(sx * x, 4.55, z));
      }
    }
    addString(poleTops[0], poleTops[1]);
    addString(poleTops[1], poleTops[2]);
    addString(poleTops[3], poleTops[4]);
    addString(poleTops[4], poleTops[5]);
    const bulbGeo = new THREE.BufferGeometry();
    bulbGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(bulbPos), 3),
    );
    const bulbs = new THREE.Points(
      bulbGeo,
      new THREE.PointsMaterial({
        color: 0xffd9a0,
        size: 0.22,
        map: makeGlowTexture(),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(bulbs);

    // --- Cột đèn rọi trời ở rìa venue — quét chậm như event ngoài trời ---
    const beaconGeo = new THREE.ConeGeometry(0.9, 34, 12, 1, true);
    beaconGeo.translate(0, 17, 0);
    for (const [x, z] of [
      [-34, 14],
      [34, 14],
      [-30, -26],
      [30, -26],
    ]) {
      const beacon = new THREE.Mesh(
        beaconGeo,
        new THREE.MeshBasicMaterial({
          color: 0xbfd4ff,
          transparent: true,
          opacity: 0.045,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
          fog: false,
        }),
      );
      beacon.position.set(x, 0, z);
      this.scene.add(beacon);
      this.beacons.push(beacon);
    }

    // --- Barricade kim loại trước sân khấu — tạo "pit" như concert thật ---
    const barMat = new THREE.MeshStandardMaterial({
      color: 0x2c3245,
      metalness: 0.8,
      roughness: 0.35,
    });
    const railGeo = new THREE.BoxGeometry(2.0, 0.055, 0.055);
    const midGeo = new THREE.BoxGeometry(2.0, 0.04, 0.04);
    const legGeo = new THREE.BoxGeometry(0.055, 1.02, 0.055);
    for (let x = -10.5; x <= 10.5; x += 2.1) {
      const rail = new THREE.Mesh(railGeo, barMat);
      rail.position.set(x, 1.02, -6.35);
      const mid = new THREE.Mesh(midGeo, barMat);
      mid.position.set(x, 0.55, -6.35);
      this.scene.add(rail, mid);
      for (const dx of [-0.95, 0.95]) {
        const leg = new THREE.Mesh(legGeo, barMat);
        leg.position.set(x + dx, 0.51, -6.35);
        this.scene.add(leg);
      }
    }
  }

  /**
   * Khán đài bậc thang (grandstand) thay cho hộp phẳng: các bậc nâng dần ra
   * sau để hàng sau nhìn qua đầu hàng trước, có thành hông, tường sau, chân
   * giàn giáo và viền LED bậc (đổi màu theo nhạc qua boothLeds).
   */
  private buildGrandstand() {
    const width = FLOOR_W + 8;
    const bottomY = -1.6;
    const zFront0 = AUDIENCE_Z0 - 0.7;
    const zBack = zFront0 + AUD_ROWS * AUD_STEP_D + 1.6;
    const yTopBack = AUDIENCE_Y + (AUD_ROWS - 1) * AUD_STEP_H;
    const deckMat = new THREE.MeshStandardMaterial({
      color: 0x0d1020,
      metalness: 0.35,
      roughness: 0.75,
    });
    const sideMat = new THREE.MeshStandardMaterial({
      color: 0x0a0c16,
      metalness: 0.4,
      roughness: 0.7,
    });
    const ledMat = new THREE.MeshBasicMaterial({ color: 0x25f4ee });

    // Các bậc: bậc sau cao hơn và kéo dài về phía sau → nhìn từ trước ra
    // các mặt bậc như khán đài sân vận động
    for (let r = 0; r < AUD_ROWS; r++) {
      const yTop = AUDIENCE_Y + r * AUD_STEP_H;
      const zf = zFront0 + r * AUD_STEP_D;
      const depth = zBack - zf;
      const h = yTop - bottomY;
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(width, h, depth),
        deckMat,
      );
      step.position.set(0, (yTop + bottomY) / 2, zf + depth / 2);
      this.scene.add(step);
      // Viền LED sáng ở mũi bậc — vạch phản quang chạy dọc mép mỗi bậc
      const nosing = new THREE.Mesh(
        new THREE.BoxGeometry(width, 0.05, 0.05),
        ledMat,
      );
      nosing.position.set(0, yTop + 0.03, zf);
      this.scene.add(nosing);
    }
    this.boothLeds.push(ledMat);

    // Thành hông hai bên khép kín khán đài (đóng khối bậc thang)
    for (const sx of [-1, 1]) {
      const cheek = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, yTopBack - bottomY + 1.2, zBack - zFront0),
        sideMat,
      );
      cheek.position.set(
        sx * (width / 2 - 0.2),
        (yTopBack + 1.2 + bottomY) / 2,
        (zFront0 + zBack) / 2,
      );
      this.scene.add(cheek);
    }

    // Tường sau + viền LED trên đỉnh — chắn hậu, khán đài không hở ra hư không
    const backWall = new THREE.Mesh(
      new THREE.BoxGeometry(width, yTopBack - bottomY + 2.4, 0.4),
      sideMat,
    );
    backWall.position.set(0, (yTopBack + 2.4 + bottomY) / 2, zBack);
    this.scene.add(backWall);
    const backLedMat = new THREE.MeshBasicMaterial({ color: 0xfe2c55 });
    const backLed = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.07, 0.07),
      backLedMat,
    );
    backLed.position.set(0, yTopBack + 2.4, zBack - 0.22);
    this.scene.add(backLed);
    this.boothLeds.push(backLedMat);

    // Chân giàn giáo lộ ra ở mặt trước — khán đài đứng trên khung thật
    const legMat = new THREE.MeshStandardMaterial({
      color: 0x1a1f30,
      metalness: 0.7,
      roughness: 0.4,
    });
    const legGeo = new THREE.CylinderGeometry(0.09, 0.09, 1.5);
    for (let i = -5; i <= 5; i++) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(i * 2.6, bottomY + 0.75, zFront0 - 0.05);
      this.scene.add(leg);
    }
  }

  private async loadStageModels() {
    const loader = new GLTFLoader();
    const tryLoad = (url: string) =>
      new Promise<THREE.Group | null>((resolve) =>
        loader.load(url, (g) => resolve(g.scene), undefined, () => resolve(null)),
      );
    const normalize = (model: THREE.Group, targetH: number) => {
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const scale = targetH / (size.y || 1);
      model.scale.setScalar(scale);
      const box2 = new THREE.Box3().setFromObject(model);
      model.position.y -= box2.min.y;
      model.position.x -= (box2.min.x + box2.max.x) / 2;
      model.position.z -= (box2.min.z + box2.max.z) / 2;
      const wrapper = new THREE.Group();
      wrapper.add(model);
      return wrapper;
    };

    const [sub, booth, spot] = await Promise.all([
      tryLoad("/models/subwoofer.glb"),
      tryLoad("/models/dj-booth.glb"),
      tryLoad("/models/spotlight.glb"),
    ]);
    if (this.disposed) return;

    if (sub) {
      this.subwooferBoxes.forEach((s) => s.removeFromParent());
      for (const x of [-8, -4, 0, 4, 8]) {
        const clone = normalize(sub.clone(true), 1.0);
        clone.position.set(x, 0, -FLOOR_D / 2 + 2.95);
        this.stageGroup.add(clone);
      }
    }
    if (booth) {
      this.boothParts.forEach((p) => p.removeFromParent());
      this.decks.forEach((d) => d.removeFromParent());
      this.decks = [];
      this.boothLeds = [];
      const clone = normalize(booth, 1.7);
      clone.position.set(0, STAGE_H, -FLOOR_D / 2 + 0.2);
      this.stageGroup.add(clone);
    }
    if (spot) {
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const clone = normalize(spot.clone(true), 1.0);
        clone.position.set(
          Math.cos(angle) * 6.2,
          10.45,
          -2 + Math.sin(angle) * 6.2,
        );
        clone.rotation.x = Math.PI;
        this.scene.add(clone);
      }
    }
  }

  private buildSlots() {
    const cols = 17;
    const rows = 13;
    this.frontSlots = [];
    this.frontSlotSet.clear();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pos = new THREE.Vector3(
          (c + 0.5 - cols / 2) * (FLOOR_W / cols - 0.1) +
            (Math.random() - 0.5) * 0.6,
          0.1,
          (r + 2.2 - rows / 2) * ((FLOOR_D - 5) / rows) +
            (Math.random() - 0.5) * 0.4,
        );
        // Hàng sát sân khấu (r=0) để dành cho top tương tác/donate
        if (r === 0) this.frontSlots.push(pos);
        else this.danceSlotsFree.push(pos);
      }
    }
    // Xếp từ giữa ra hai bên — hạng cao nhất đứng chính giữa
    this.frontSlots.sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
    this.frontRow = this.frontSlots.map(() => null);
    this.frontSlots.forEach((p) => this.frontSlotSet.add(p));
    // Đứng trên bậc thang khán đài: hàng sau cao dần + lùi xa dần
    for (let r = 0; r < AUD_ROWS; r++) {
      for (let c = 0; c < 18; c++) {
        this.audienceSlotsFree.push(
          new THREE.Vector3(
            (c + 0.5 - 9) * 1.55 + (Math.random() - 0.5) * 0.4,
            AUDIENCE_Y + r * AUD_STEP_H,
            AUDIENCE_Z0 + r * AUD_STEP_D + (Math.random() - 0.5) * 0.2,
          ),
        );
      }
    }
    for (const pool of [this.danceSlotsFree, this.audienceSlotsFree]) {
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }
  }

  private takeSlot(zone: "floor" | "audience"): THREE.Vector3 {
    const pool =
      zone === "floor" ? this.danceSlotsFree : this.audienceSlotsFree;
    const pos = pool.pop();
    if (pos) return pos;
    return zone === "floor"
      ? new THREE.Vector3(
          (Math.random() - 0.5) * (FLOOR_W - 2),
          0.1,
          (Math.random() - 0.5) * (FLOOR_D - 6),
        )
      : new THREE.Vector3(
          (Math.random() - 0.5) * FLOOR_W,
          AUDIENCE_Y,
          AUDIENCE_Z0 + Math.random() * 1.6,
        );
  }

  private releaseSlot(userId: string) {
    const ref = this.playerSlots.get(userId);
    if (!ref) return;
    if (this.frontSlotSet.has(ref.pos)) {
      // Chỗ hàng đầu là khu để dành riêng — không trả vào pool thường
      const idx = this.frontSlots.indexOf(ref.pos);
      if (idx >= 0) this.frontRow[idx] = null;
    } else if (ref.zone !== "podium") {
      (ref.zone === "floor"
        ? this.danceSlotsFree
        : this.audienceSlotsFree
      ).push(ref.pos);
    }
    this.playerSlots.delete(userId);
  }

  /**
   * Xếp lại hàng đầu sát sân khấu theo điểm tương tác/donate.
   * Người đã ở hàng đầu giữ nguyên chỗ để tránh xáo trộn liên tục.
   */
  private updateFrontRow() {
    const dancers: Player[] = [];
    this.players.forEach((p) => {
      if (p.onFloor && !p.onPodium && p.score > 0) dancers.push(p);
    });
    dancers.sort((a, b) => b.score - a.score);
    const top = dancers.slice(0, this.frontSlots.length);
    const topSet = new Set(top);
    this.frontRow.forEach((p, i) => {
      if (p && (!topSet.has(p) || !p.onFloor)) {
        this.frontRow[i] = null;
        const pos = this.takeSlot("floor");
        this.playerSlots.set(p.user.userId, { zone: "floor", pos });
        p.setHome(pos);
      }
    });
    top.forEach((p) => {
      if (this.frontRow.includes(p)) return;
      const free = this.frontRow.findIndex((v) => v === null);
      if (free === -1) return;
      this.releaseSlot(p.user.userId);
      this.frontRow[free] = p;
      this.playerSlots.set(p.user.userId, {
        zone: "floor",
        pos: this.frontSlots[free],
      });
      p.setHome(this.frontSlots[free]);
    });
  }

  /**
   * Khởi động một màn đồng diễn: bốc điệu hợp thể loại + năng lượng đoạn nhạc,
   * rồi dàn cả sàn theo MỘT đội hình để có "hình khối" bắt mắt thay vì ai nấy
   * nhảy rời rạc:
   * - unison: cả sàn vào cùng điệu, cùng nhịp — cú đồng loạt đanh (dùng khi drop).
   * - wave:   kích hoạt so le theo trục X → điệu lan như sóng từ trái sang phải.
   * - split:  hai nửa sàn nhảy hai điệu → gọi-đáp qua lại.
   * - canon:  so le theo trục Z (hàng gần → xa) → điệu đuổi nhau theo hàng.
   * Đội hình động (wave/split) hợp đoạn bốc; đội hình dịu (unison/canon) khi lắng.
   */
  private startChoreo(
    baseBeat: number,
    intensity: number,
    force?: "unison" | "wave" | "split" | "canon",
  ) {
    const floor = [...this.players.values()].filter(
      (p) => p.onFloor && !p.forcedMove,
    );
    if (floor.length < 3) return;

    const pool = GENRE_MOVES[this.music.genre];
    const moveA = pickEnergyMove(pool, intensity);
    let moveB = pickEnergyMove(pool, intensity);
    if (moveB === moveA) moveB = pickEnergyMove(pool, intensity);

    // Chọn đội hình: năng lượng cao thiên về sóng/gọi-đáp (động), lắng thì
    // đồng loạt/canon (gọn). Có ngẫu nhiên để không đoán trước được.
    const r = Math.random();
    const formation: "unison" | "wave" | "split" | "canon" =
      force ??
      (intensity > 0.66
        ? r < 0.4
          ? "wave"
          : r < 0.72
            ? "split"
            : "unison"
        : r < 0.4
          ? "canon"
          : r < 0.7
            ? "unison"
            : "wave");
    this.choreoMove = moveA;

    // Biên vị trí sàn để chuẩn hóa 0..1 cho sóng/canon
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of floor) {
      const pos = this.playerSlots.get(p.user.userId)?.pos;
      if (!pos) continue;
      if (pos.x < minX) minX = pos.x;
      if (pos.x > maxX) maxX = pos.x;
      if (pos.z < minZ) minZ = pos.z;
      if (pos.z > maxZ) maxZ = pos.z;
    }
    const spanX = Math.max(0.001, maxX - minX);
    const spanZ = Math.max(0.001, maxZ - minZ);
    // Sóng/canon lan trong ~6 nhịp; đủ chậm để mắt thấy rõ, đủ nhanh để không lê
    const spread = formation === "wave" ? 6 : formation === "canon" ? 5 : 0;

    for (const p of floor) {
      const pos = this.playerSlots.get(p.user.userId)?.pos;
      let move = moveA;
      let delay = 0;
      if (formation === "split") {
        move = (pos?.x ?? 0) < 0 ? moveA : moveB;
      } else if (formation === "wave" && pos) {
        delay = Math.round(((pos.x - minX) / spanX) * spread);
      } else if (formation === "canon" && pos) {
        delay = Math.round(((pos.z - minZ) / spanZ) * spread);
      }
      p.choreoMove = move;
      p.choreoFromBeat = baseBeat + delay;
    }

    const durBars = intensity > 0.66 ? 4 : 2; // 16 hay 8 nhịp giữ điệu
    this.choreoEndBeat = baseBeat + spread + durBars * 4;
    this.nextChoreoBeat = this.choreoEndBeat + 4;
  }

  /**
   * Chọn hoạ tiết sàn hợp năng lượng đoạn nhạc: đoạn lắng ra hoạ tiết dịu
   * (lấp lánh / vòng lan), điệp khúc ra hoạ tiết động (ô cờ chớp / chong chóng
   * / quét / đuổi hàng). Có ngẫu nhiên để không lặp lại đoán trước được.
   */
  private pickFloorPattern(intensity: number): FloorPattern {
    const calm: FloorPattern[] = ["sparkle", "ring", "ripple", "ring"];
    const mid: FloorPattern[] = ["ring", "ripple", "sweep", "rows", "spiral"];
    const hot: FloorPattern[] = [
      "checker",
      "spiral",
      "sweep",
      "rows",
      "checker",
    ];
    const pool = intensity > 0.66 ? hot : intensity < 0.4 ? calm : mid;
    let next = pool[Math.floor(Math.random() * pool.length)];
    if (next === this.floor.currentPattern)
      next = pool[Math.floor(Math.random() * pool.length)];
    return next;
  }

  /**
   * Chọn top vũ công tương tác nhiều nhất (điểm chat/tim/donate) đang trên
   * sàn/podium để dựng con rối cutout (tay/chân + biểu cảm mượt hơn); còn lại
   * giữ sprite phẳng cho nhẹ máy. Số lượng theo rules.rigDancers (0 = tắt).
   */
  private updateRigs() {
    const cand = [...this.players.values()].filter(
      (p) => (p.onFloor || p.onPodium) && p.canRig,
    );
    let chosen: Set<Player>;
    if (this.showcaseMode) {
      // Trang preview: dựng rig cho TẤT CẢ (tối đa 30) để xem rõ thiết kế mới
      chosen = new Set(cand.slice(0, 30));
    } else {
      // Live: chỉ top người tương tác nhiều nhất (điểm chat/tim/donate)
      const n = Math.max(0, this.rules.rigDancers | 0);
      cand.sort((a, b) => b.score - a.score);
      chosen = new Set(cand.slice(0, n));
    }
    for (const p of this.players.values()) {
      const want = chosen.has(p);
      if (want !== p.hasRig) p.setRig(want);
    }
  }

  private promoteToFloor(player: Player) {
    const pos = this.takeSlot("floor");
    this.releaseSlot(player.user.userId);
    this.playerSlots.set(player.user.userId, { zone: "floor", pos });
    player.onFloor = true;
    player.floorEligible = true;
    player.setZone("floor");
    player.setHome(pos);
    if (!player.forcedMove) {
      player.choreoMove = this.choreoMove;
      // Người mới lên sàn vào điệu đồng diễn ngay (không lệch nhịp)
      player.choreoFromBeat = this.beatIndex;
    }
  }

  private demoteToAudience(player: Player) {
    const pos = this.takeSlot("audience");
    this.releaseSlot(player.user.userId);
    this.playerSlots.set(player.user.userId, { zone: "audience", pos });
    player.onFloor = false;
    player.setZone("audience");
    player.setHome(pos);
    player.choreoMove = null;
    // Rời sàn thì bỏ rig ngay (rig chỉ cho người trên sân khấu)
    player.setRig(false);
  }

  async useCustomSkins(urls: string[]) {
    if (!urls.length) return;
    const custom = await loadCustomSkins(urls);
    if (!custom.length || this.disposed) return;
    this.preuploadSkins(custom);
    this.skins = custom;
    this.players.forEach((p) => p.setSkins(custom));
    const dj = custom[3 % custom.length];
    this.djDefaultMap = dj.frames[0];
    this.djDefaultFrames = dj.frames;
    this.djDefaultW = 2.125 * dj.aspect;
    if (!this.djTakeover) {
      this.djSprite.material.map = this.djDefaultMap;
      this.djSprite.material.needsUpdate = true;
      this.djFrames = this.djDefaultFrames;
      this.djW = this.djDefaultW;
      this.djSprite.scale.set(this.djW, 2.125, 1);
    }
  }

  private ensurePlayer(user: LiveUser): Player {
    let player = this.players.get(user.userId);
    if (!player) {
      if (this.players.size >= MAX_PLAYERS) this.evictOldest();
      const zone = this.rules.zoneMode === "all-floor" ? "floor" : "audience";
      const slot = this.takeSlot(zone);
      this.playerSlots.set(user.userId, { zone, pos: slot });
      player = new Player(user, this.skins, slot);
      player.setSkin(this.pickFreeSkin());
      player.setZone(zone);
      if (zone === "floor") {
        player.onFloor = true;
        player.floorEligible = true;
        player.startDancing(Number.POSITIVE_INFINITY);
      }
      this.players.set(user.userId, player);
      this.scene.add(player.group);
    }
    player.lastActive = performance.now();
    return player;
  }

  /** Skin chưa ai dùng cho user mới; hết skin trống thì mới cho phép trùng. */
  private pickFreeSkin(): number {
    const used = new Set<number>();
    this.players.forEach((p) => used.add(p.skinNumber));
    const free: number[] = [];
    for (let i = 0; i < this.skins.length; i++) {
      if (!used.has(i)) free.push(i);
    }
    if (!free.length) return Math.floor(Math.random() * this.skins.length);
    return free[Math.floor(Math.random() * free.length)];
  }

  private evictOldest() {
    let oldest: Player | null = null;
    for (const p of this.players.values()) {
      if (!oldest || p.lastActive < oldest.lastActive) oldest = p;
    }
    if (oldest) this.removePlayer(oldest);
  }

  /** Chọn một vũ công đang nhảy trên sàn — cho các cú cận cảnh có chủ thể. */
  private pickActiveDancer(): Player | null {
    const pool: Player[] = [];
    this.players.forEach((p) => {
      if (p.onFloor && !p.onPodium) pool.push(p);
    });
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Đổi sang góc máy mới — tránh lặp 2 shot gần nhất VÀ cùng kiểu khung liên
   * tiếp (để nhịp cắt đa dạng như cameraman thật), lọc theo loại khung.
   */
  private switchShot(
    shots: CamShot[],
    opts: { kinds?: CamShot["kind"][]; cut?: boolean; energy: number },
  ) {
    const curKind = shots[this.shotIdx % shots.length]?.kind;
    const inKinds = (s: CamShot) => !opts.kinds || opts.kinds.includes(s.kind);
    // Ưu tiên: khác index gần đây + khác KIỂU góc hiện tại + trong nhóm cho phép
    let candidates = shots
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s, i }) =>
          i !== this.shotIdx &&
          i !== this.prevShotIdx &&
          s.kind !== curKind &&
          inKinds(s),
      );
    if (!candidates.length) {
      candidates = shots
        .map((s, i) => ({ s, i }))
        .filter(({ s, i }) => i !== this.shotIdx && inKinds(s));
    }
    if (!candidates.length) {
      candidates = shots
        .map((s, i) => ({ s, i }))
        .filter(({ i }) => i !== this.shotIdx);
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    this.prevShotIdx = this.shotIdx;
    this.shotIdx = pick.i;
    this.takeT = 0;
    this.takeBeats = 0;
    this.camCut = !!opts.cut;
    // Nhạc căng lướt nhanh dứt khoát, nhạc êm trôi chậm rãi
    this.camGlide = 0.3 + opts.energy * 0.6;
    this.camMoveMode = Math.random() < 0.6 ? "push" : "slide";
    // Cận/trung cảnh: bám một CHỦ THỂ thật để khung luôn có người, không ngắm
    // trúng chỗ trống. Góc rộng/trên/cánh giữ điểm ngắm sân khấu cố định.
    this.camSubject =
      pick.s.kind === "close" || pick.s.kind === "medium"
        ? this.pickHeroSubject()
        : null;
  }

  /**
   * Chọn "nhân vật chính" để đóng khung: ưu tiên người đang được spotlight,
   * rồi hàng đầu (top tương tác/donate), cuối cùng là vũ công bất kỳ trên sàn.
   */
  private pickHeroSubject(): Player | null {
    if (this.spotlightPlayer?.onFloor) return this.spotlightPlayer;
    const front = this.frontRow.filter(
      (p): p is Player => !!p && p.onFloor && !p.onPodium,
    );
    if (front.length)
      return front[Math.floor(Math.random() * front.length)];
    return this.pickActiveDancer();
  }

  /** Cắt thẳng sang góc toàn cảnh — phản xạ của cameraman khi drop/vào điệp khúc. */
  private cutToWide() {
    // Admin đang khóa góc hoặc chế độ toàn cảnh cố định thì không tự cắt
    if (this.cameraLocked || this.rules.cameraMode === "overview") return;
    const shots =
      this.rules.cameraMode === "orbit" ? ORBIT_SHOTS : FRONT_SHOTS;
    this.switchShot(shots, { kinds: ["wide", "top"], cut: true, energy: 1 });
    this.takeLen = 8;
  }

  /**
   * Vào chế độ camera tự do (admin điều khiển tay). Khởi tạo toạ độ cầu
   * (yaw/pitch/bán kính) từ đúng vị trí camera hiện tại để không nhảy hình.
   */
  private enterFreeCam() {
    this.cameraLocked = true;
    if (this.freeCam) return;
    this.freeCam = true;
    const off = this.camPos.clone().sub(this.fcTarget);
    this.fcRadius = Math.max(5, off.length());
    this.fcYaw = Math.atan2(off.x, off.z);
    this.fcPitch = Math.asin(
      Math.max(-1, Math.min(1, off.y / this.fcRadius)),
    );
    this.camGlide = 1.6;
  }

  /** Admin xoay camera quanh sân khấu theo mọi hướng (yaw ngang, pitch dọc). */
  orbitCamera(dYaw: number, dPitch: number) {
    this.enterFreeCam();
    this.fcYaw += dYaw;
    // Chặn chúc quá thấp (xuyên xuống dưới sàn) và lật qua đỉnh
    this.fcPitch = Math.max(-0.1, Math.min(1.45, this.fcPitch + dPitch));
  }

  /** Admin phóng to / thu xa (dolly theo bán kính). */
  zoomCamera(dRadius: number) {
    this.enterFreeCam();
    this.fcRadius = Math.max(5, Math.min(52, this.fcRadius + dRadius));
  }

  /** Admin dời điểm ngắm (pan ngang/dọc) — quan sát khu vực khác. */
  panCamera(dx: number, dy: number) {
    this.enterFreeCam();
    this.fcTarget.x = Math.max(-24, Math.min(24, this.fcTarget.x + dx));
    this.fcTarget.y = Math.max(-1, Math.min(10, this.fcTarget.y + dy));
  }

  /** Trả camera về chế độ đạo diễn tự động. */
  unlockCamera() {
    this.cameraLocked = false;
    this.freeCam = false;
  }

  /** HUD gọi khi đổi bài — cập nhật màn hình "đang phát" trên bàn FOH. */
  setNowPlayingScreen(title: string, thumb?: string) {
    this.infoScreens.setNowPlaying(title, thumb);
  }

  /** HUD gọi khi playlist đổi — cập nhật màn hình playlist trên bàn FOH. */
  setPlaylistScreen(items: InfoTrack[], current: number) {
    this.infoScreens.setPlaylist(items, current);
  }

  /** Gỡ hẳn một người khỏi sàn: trả slot, xóa khỏi scene và mọi tham chiếu. */
  private removePlayer(player: Player) {
    this.scene.remove(player.group);
    player.dispose();
    this.releaseSlot(player.user.userId);
    this.players.delete(player.user.userId);
    const fr = this.frontRow.indexOf(player);
    if (fr >= 0) this.frontRow[fr] = null;
    if (this.focusPlayer === player) this.focusPlayer = null;
    if (this.spotlightPlayer === player) this.spotlightPlayer = null;
    if (this.camSubject === player) this.camSubject = null;
  }

  handleChat(event: ChatEvent) {
    const player = this.ensurePlayer(event.user);
    const r = this.rules;
    const isStart =
      normalizeComment(event.comment) === normalizeComment(r.startCommand);

    // User vừa order nhạc: tin chat kế tiếp = bài muốn nghe → thêm playlist
    if (
      !isStart &&
      this.djOrderWaiting &&
      this.djOrderWaiting.userId === event.user.userId &&
      event.comment.trim()
    ) {
      const request = this.djOrderWaiting;
      this.djOrderWaiting = null;
      this.onSongRequest?.(request.nickname, event.comment.trim());
      player.say(event.comment);
      this.showBanner(`🎵 ${request.nickname} yêu cầu: ${event.comment.trim()}`);
      player.score += 1;
      this.hype = Math.min(1, this.hype + 0.015);
      return;
    }

    player.keepDancing(r.danceExtendSec * 1000, r.danceMaxSec * 1000);
    if (isStart || !r.requireStartCommand) {
      // Chat đúng lệnh (hoặc setting không bắt buộc lệnh) mới cho lên sàn
      player.floorEligible = true;
      player.startDancing(
        r.stayOnFloor ? Number.POSITIVE_INFINITY : r.danceStartSec * 1000,
      );
    }

    // MỌI comment (trừ lệnh lên sàn) đều hiện bong bóng trên đầu nhân vật —
    // kể cả comment trùng lệnh ("nhảy", "đổi nv"...) để ai chat cũng thấy mình
    if (!isStart) player.say(event.comment);
    const command = r.commandsEnabled ? parseCommand(event.comment) : null;
    switch (command) {
      case "jump":
        player.jump();
        break;
      case "swap-skin":
        player.swapSkin();
        break;
      case "run-circle":
        player.runCircle();
        break;
      case "grow":
        player.grow();
        break;
      case "shrink":
        player.shrink();
        break;
      default:
        break;
    }
    player.score += 1;
    this.hype = Math.min(1, this.hype + 0.015);
  }

  handleGift(event: GiftEvent) {
    const player = this.ensurePlayer(event.user);
    player.celebrate();
    // Ép các trường số về hữu hạn — event thiếu trường sẽ thành NaN, làm hỏng
    // điểm/sort/podium và số hạt confetti
    const diamondCount = num(event.diamondCount);
    const repeatCount = num(event.repeatCount, 1);
    const totalDiamonds = num(event.totalDiamonds);
    const bursts = Math.min(
      6,
      1 + Math.floor((diamondCount * repeatCount) / 100),
    );
    this.confetti.burst(30 + bursts * 20);
    this.showBanner(
      `🎁 ${event.user.nickname} tặng ${event.giftName} ×${repeatCount}` +
        (totalDiamonds > 0 ? ` 💎${totalDiamonds}` : ""),
    );

    // Cộng 💎 TRƯỚC khi xử lý action — orderDj cần so tổng donate mới nhất
    if (!event.streaking) {
      player.diamonds += totalDiamonds;
      // Donate tính điểm nặng nhất — 1💎 = 5 điểm tương tác
      player.score += totalDiamonds * 5;
      // Đổi màu tên theo mốc donate mới (trắng → xanh/vàng/hồng/tím VIP)
      player.refreshNameTag();
      this.updatePodium();
    }

    const value = diamondCount;
    const matched = this.rules.giftActions
      .filter((rule) => value >= rule.min)
      .sort((a, b) => b.min - a.min)[0];
    switch (matched?.action) {
      case "badge":
        player.giveBadge();
        player.grow();
        this.focusOn(player);
        break;
      case "focus":
        this.focusOn(player);
        break;
      case "fireworks":
        this.fireworks.spawn(player.group.position, 3);
        this.confetti.burst(80);
        break;
      case "grow":
        player.grow();
        break;
      case "shrink":
        player.shrink();
        break;
      case "swap":
        player.swapSkin();
        break;
      case "circle":
        player.runCircle();
        break;
      case "jump":
        player.jump();
        break;
      case "dj":
        this.orderDj(player);
        break;
      default:
        break;
    }
    // Ai donate cũng được spotlight — đèn rọi + mờ nhân vật xung quanh
    if (event.diamondCount > 0) this.spotlightOn(player);
    this.hype = Math.min(1, this.hype + 0.18);
  }

  private focusOn(player: Player, ms = 3500) {
    this.focusPlayer = player;
    this.focusUntil = performance.now() + ms;
    player.showLabel(ms + 1200);
  }

  /**
   * Order nhạc: user thay NPC đứng bàn DJ, tên hiện trên màn hình "now playing".
   * Tin chat kế tiếp của user này được coi là bài muốn nghe (link/tên bài).
   * Giới hạn số lượt mỗi bài đặt trong Settings (djOrderPerSong).
   */
  private orderDj(player: Player) {
    if (this.djOrdersThisSong >= this.rules.djOrderPerSong) return;
    this.djOrdersThisSong++;
    const info = {
      userId: player.user.userId,
      nickname: player.user.nickname,
    };
    this.djOrderWaiting = info;
    this.npScreen.orderedBy = player.user.nickname;
    // Chỉ người tặng NHIỀU NHẤT mới được đứng bàn DJ — còn lại order từ dưới
    let maxOther = 0;
    this.players.forEach((p) => {
      if (p !== player) maxOther = Math.max(maxOther, p.diamonds);
    });
    if (player.diamonds > 0 && player.diamonds >= maxOther) {
      this.djTakeover = info;
      this.djSprite.material.map = player.texture;
      this.djSprite.material.needsUpdate = true;
      this.djFrames = player.skinFrames;
      this.djW = 2.125 * player.skinAspect;
      this.showBanner(
        `🎧 ${player.user.nickname} top donate — lên bàn DJ! Chat tên bài/link để thêm vào playlist`,
      );
    } else {
      this.showBanner(
        `🎧 ${player.user.nickname} order nhạc — chat tên bài/link để thêm vào playlist`,
      );
    }
  }

  /** Quà có action theo setting → mờ các nhân vật khác vài giây cho nổi bật. */
  private spotlightOn(player: Player, ms = 4000) {
    this.spotlightPlayer = player;
    this.spotlightUntil = performance.now() + ms;
    player.showLabel(ms + 800);
  }

  /**
   * orderedBy: nickname người order nếu bài này do user yêu cầu — giữ họ trên
   * bàn DJ suốt bài; bài thường (null) thì trả bàn DJ về NPC mặc định.
   */
  async playMusic(url: string, title: string, orderedBy: string | null = null) {
    this.djOrdersThisSong = 0;
    const keepTakeover =
      this.djTakeover !== null && orderedBy === this.djTakeover.nickname;
    if (!keepTakeover) {
      this.djTakeover = null;
      this.djOrderWaiting = null;
      if (this.djDefaultMap) {
        this.djSprite.material.map = this.djDefaultMap;
        this.djSprite.material.needsUpdate = true;
      }
      this.djFrames = this.djDefaultFrames;
      this.djW = this.djDefaultW;
      this.npScreen.orderedBy = orderedBy;
    }
    await this.music.play(url, title);
    this.npScreen.setTitle(title);
    // Chào sân bài mới: một loạt lửa + CO2 như pháo mở màn sân khấu thật
    this.inClimax = false;
    this.flames.fire(1.1);
    this.smokeJets.blast(1);
    this.frontSparks.fire(1);
  }

  handleLike(event: LikeEvent) {
    const count = num(event.count, 1);
    this.hype = Math.min(1, this.hype + count * 0.014);
    const player = this.players.get(event.user.userId);
    if (player) {
      player.lastActive = performance.now();
      player.score += count * 0.05;
    }
  }

  handleActivity(event: ActivityEvent) {
    const player = this.ensurePlayer(event.user);
    if (event.kind === "follow" || event.kind === "share") {
      player.celebrate();
      player.score += 2;
      this.hype = Math.min(1, this.hype + 0.06);
    }
  }

  reset() {
    this.stopDemo();
    this.showcaseMode = false;
    this.players.forEach((p) => {
      this.scene.remove(p.group);
      p.dispose();
    });
    this.players.clear();
    this.playerSlots.clear();
    this.danceSlotsFree = [];
    this.audienceSlotsFree = [];
    this.buildSlots();
    this.hype = 0;
    this.choreoMove = null;
    this.choreoEndBeat = 0;
    this.nextChoreoBeat = this.beatIndex + 32;
    this.nextFloorBeat = this.beatIndex + 16;
    this.banners.forEach((b) => this.scene.remove(b.sprite));
    this.banners = [];
    this.podium.forEach((slot) => {
      slot.userId = null;
      slot.label.material.opacity = 0;
    });
  }

  private showBanner(text: string) {
    const { texture, aspect } = makeLabelTexture(text, "#ffc94d");
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true }),
    );
    const h = 0.62;
    sprite.scale.set(h * aspect, h, 1);
    sprite.position.set(0, 8.6, -4);
    this.scene.add(sprite);
    this.banners.push({ sprite, age: 0 });
    if (this.banners.length > 3) {
      const old = this.banners.shift()!;
      this.scene.remove(old.sprite);
      old.sprite.material.map?.dispose();
      old.sprite.material.dispose();
    }
    this.banners.forEach((b, i) => {
      b.sprite.position.y = 8.6 - (this.banners.length - 1 - i) * 0.8;
    });
  }

  private updateBanners(dt: number) {
    for (let i = this.banners.length - 1; i >= 0; i--) {
      const b = this.banners[i];
      b.age += dt;
      if (b.age > 3.2) {
        this.scene.remove(b.sprite);
        b.sprite.material.map?.dispose();
        b.sprite.material.dispose();
        this.banners.splice(i, 1);
      } else {
        b.sprite.material.opacity = Math.min(1, (3.2 - b.age) / 0.5);
      }
    }
  }

  private updatePodium() {
    const top = [...this.players.values()]
      .filter((p) => p.diamonds > 0)
      .sort((a, b) => b.diamonds - a.diamonds)
      .slice(0, 3);
    const topIds = new Set(top.map((p) => p.user.userId));

    for (const slot of this.podium) {
      if (!slot.userId || topIds.has(slot.userId)) continue;
      const player = this.players.get(slot.userId);
      slot.userId = null;
      slot.label.material.opacity = 0;
      if (player) {
        player.onPodium = false;
        if (player.isDancing) this.promoteToFloor(player);
        else this.demoteToAudience(player);
      }
    }
    this.podium.forEach((slot, i) => {
      const expected = top[i]?.user.userId ?? null;
      if (slot.userId !== expected) {
        slot.userId = null;
        slot.label.material.opacity = 0;
      }
    });

    const medals = ["🥇", "🥈", "🥉"];
    top.forEach((player, i) => {
      const slot = this.podium[i];
      if (slot.userId !== player.user.userId) {
        slot.userId = player.user.userId;
        this.releaseSlot(player.user.userId);
        this.playerSlots.set(player.user.userId, {
          zone: "podium",
          pos: slot.pos,
        });
        player.onPodium = true;
        player.onFloor = false;
        player.setZone("podium");
        player.startDancing(Number.POSITIVE_INFINITY);
        player.setHome(slot.pos);
      }
      slot.label.material.map?.dispose();
      const { texture, aspect } = makeLabelTexture(
        `${medals[i]} ${player.user.nickname} · ${player.diamonds}💎`,
        "#ffc94d",
      );
      slot.label.material.map = texture;
      slot.label.material.opacity = 1;
      slot.label.material.needsUpdate = true;
      const h = 0.4;
      slot.label.scale.set(h * aspect, h, 1);
    });
  }

  get demoRunning() {
    return this.demoTimers.length > 0;
  }

  startDemo() {
    if (this.demoRunning) return;
    const names = [
      "Công chúa 🌸", "Chùm nho x", "Bé Na", "Anh Bảy", "Mều 🐱", "Tũn",
      "Sói Ca", "Gấu 🐻", "Bắp Rang", "Cu Tí", "Chị Đại", "Ông Chú Vui Vẻ",
      "Mập Ú", "Cô Ba SG", "Tôm Càng", "Nhím Xù", "Bánh Bao", "Su Su",
      "Đầu Nấm Chúa", "Lúa Non", "Cà Khịa Boy", "Trà Sữa", "Mỳ Cay 7", "Bơ Sữa",
    ];
    const bots: LiveUser[] = names.map((n, i) => ({
      userId: `demo-${i}`,
      uniqueId: `demo_${i}`,
      nickname: n,
      avatarUrl: null,
    }));
    const pick = () => bots[Math.floor(Math.random() * bots.length)];
    const now = () => Date.now();
    let id = 0;

    const start = this.rules.startCommand;
    const phrases = [
      start, start, start,
      "hello cả nhà 👋", "quẩy lên nào!!!", "nhạc gì căng z", "cho 1 slot",
      "kkkk", "đỉnh quá", "ai kb hông", "xin vía 🍀",
      "nhảy", "đi vòng", "to lên", "nhỏ lại", "đổi nv", "hay quá trời",
      "10 điểm", "vô đây coi nè", "🔥🔥🔥",
    ];
    const gifts = [
      { name: "Hoa hồng", diamonds: 1 },
      { name: "Tim tay", diamonds: 5 },
      { name: "Vịt vàng", diamonds: 10 },
      { name: "Vương miện", diamonds: 99 },
      { name: "Sư tử", diamonds: 500 },
    ];

    const seed = setInterval(() => {
      const user = pick();
      this.handleActivity({ id: `demo-a-${id++}`, kind: "join", user, ts: now() });
      setTimeout(() => {
        this.handleChat({ id: `demo-c-${id++}`, user, comment: start, ts: now() });
      }, 600 + Math.random() * 2000);
    }, 350);
    setTimeout(() => clearInterval(seed), 9000);

    this.demoTimers.push(
      setInterval(() => {
        this.handleChat({
          id: `demo-c-${id++}`,
          user: pick(),
          comment: phrases[Math.floor(Math.random() * phrases.length)],
          ts: now(),
        });
      }, 450),
      setInterval(() => {
        this.handleLike({
          user: pick(),
          count: 1 + Math.floor(Math.random() * 6),
          ts: now(),
        });
      }, 300),
      setInterval(() => {
        const gift = gifts[Math.floor(Math.random() * gifts.length)];
        const repeat =
          gift.diamonds <= 10 ? 1 + Math.floor(Math.random() * 15) : 1;
        this.handleGift({
          id: `demo-g-${id++}`,
          user: pick(),
          giftId: gift.name,
          giftName: gift.name,
          giftImageUrl: null,
          diamondCount: gift.diamonds,
          repeatCount: repeat,
          streaking: false,
          totalDiamonds: gift.diamonds * repeat,
          ts: now(),
        });
      }, 4200),
      setInterval(() => {
        this.handleActivity({
          id: `demo-a-${id++}`,
          kind: Math.random() < 0.5 ? "join" : "follow",
          user: pick(),
          ts: now(),
        });
      }, 1600),
    );
  }

  stopDemo() {
    this.demoTimers.forEach(clearInterval);
    this.demoTimers = [];
  }

  startShowcase() {
    this.reset();
    this.showcaseMode = true;
    const total = Math.min(
      Math.max(this.skins.length * 2, ALL_DANCE_MOVES.length * 2),
      40,
    );
    for (let i = 0; i < total; i++) {
      const move = ALL_DANCE_MOVES[i % ALL_DANCE_MOVES.length];
      const player = this.ensurePlayer({
        userId: `test-${i}`,
        uniqueId: `test_${i}`,
        nickname: `${move} · skin ${(i % this.skins.length) + 1}`,
        avatarUrl: null,
      });
      this.promoteToFloor(player);
      player.setSkin(i % this.skins.length);
      player.forcedMove = move;
      player.startDancing(Number.POSITIVE_INFINITY);
    }
    this.hype = 0.5;
    // Bật rig ngay để preview là "showroom" con rối mới (không chờ 4s)
    this.updateRigs();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const frameT = performance.now();
    const dt = Math.min((frameT - this.lastFrameT) / 1000, 0.05);
    this.lastFrameT = frameT;
    const t = frameT / 1000;

    this.music.sensitivity = this.rules.beatSensitivity;
    this.music.update();
    let beat: Beat;
    if (this.music.playing) {
      const raw = this.music.getBeat();
      // Dịch lưới về phách 1 THẬT (downbeat detector) — mọi accent %4/%8
      // của đèn, pyro, dancer đều rơi đúng đầu ô nhịp
      beat = { index: raw.index - this.music.barOffset, pulse: raw.pulse };
      this.beatIndex = beat.index;
    } else {
      beat = { index: this.beatIndex, pulse: 1 };
    }

    // Backstop: NaN lọt vào hype sẽ lan ra mọi Math.min/max thành NaN vĩnh
    // viễn → toạ độ vũ công NaN → mất sạch nhân vật tới khi reload. Tự chữa.
    if (!Number.isFinite(this.hype)) this.hype = 0;
    this.hype = Math.max(0, this.hype - HYPE_DECAY_PER_S * dt);
    const effHype = Math.max(this.hype, this.music.level * 0.75);
    const level = this.music.playing ? this.music.level : 0;
    const drop = this.music.dropLevel;

    // Tâm trạng bài hát → bảng màu toàn sàn: buồn = xanh tím trầm, vui =
    // vàng cam rực, mạnh = kéo về đỏ hồng. Hue đổi rất chậm nên không giật.
    const valence = this.music.moodValence;
    let mEnergy = this.music.playing ? this.music.moodEnergy : 0.25;
    let moodHue = 0.66 - valence * 0.5;
    if (mEnergy > 0.55) {
      moodHue = lerpHue(
        moodHue,
        0.97,
        Math.min(1, (mEnergy - 0.55) / 0.35) * 0.65,
      );
    }
    // Thể loại nhạc phủ "chất" riêng lên bảng màu, tốc độ đèn và điệu nhảy
    const genre = this.music.playing ? this.music.genre : "pop";
    const gLight = GENRE_LIGHT[genre];
    moodHue = (moodHue + gLight.hueShift + 1) % 1;
    mEnergy = Math.min(1, mEnergy * gLight.energyMul);
    const mood = { hue: moodHue, energy: mEnergy, valence };
    this.vibe.genre = genre;
    this.vibe.melodyTrend = this.music.playing ? this.music.melodyTrend : 0;
    this.vibe.melodyHeight = this.music.melodyHeight;
    // Năng lượng đám đông = độ mạnh đoạn nhạc, cộng hype tương tác. Điều tiết
    // biên độ nhún + độ dữ của điệu: verse lắng, điệp khúc/drop bùng.
    this.vibe.intensity = this.music.playing
      ? Math.min(1, Math.max(this.music.section, effHype * 0.7) + drop * 0.3)
      : 0.35;

    // Mỗi beat mới: đèn moving head quét sang mốc mới + đồng diễn 32-beat
    if (this.music.playing && beat.index !== this.lastLoopBeat) {
      this.lastLoopBeat = beat.index;
      this.movingHeads.forEach((_, i) => {
        this.mhPan[i] =
          (((beat.index + i) % 2) * 2 - 1) * (0.35 + Math.random() * 0.3);
      });
      // PYRO DIRECTOR — bắt chước người chạy hiệu ứng sân khấu thật:
      // 1) Khoảnh khắc VÀO điệp khúc (section vượt ngưỡng lần đầu): toàn dàn
      //    khai hỏa một loạt lửa + CO2 đánh dấu cú bung.
      // 2) Trong điệp khúc: chạy pattern theo phách — lửa đuổi vòng quanh
      //    sàn / từ giữa tỏa ra hai bên / cả dàn dậm phách 1 — đổi pattern
      //    mỗi 4 ô nhịp cho đỡ lặp; CO2 nhấn phách 1 mỗi 2 ô nhịp.
      // 3) Đoạn trầm/buildup: CO2 nhả hơi ngắn như nén hơi chờ bung.
      const section = this.music.section;
      if (section > 0.72 && !this.inClimax && level > 0.12) {
        this.inClimax = true;
        this.pyroPattern = Math.floor(Math.random() * 3);
        this.flames.fire(1.3);
        this.smokeJets.blast(1.2);
        this.frontSparks.fire(1.2);
        // Vào điệp khúc: cameraman cắt thẳng sang toàn cảnh đón cú bung,
        // DJ bật nhảy ăn mừng, cả sàn vào đồng diễn năng lượng cao ngay
        // (không chờ hẹn giờ) — khoảnh khắc bùng khớp đúng câu nhạc
        this.cutToWide();
        this.djJumpT = 0;
        this.startChoreo(beat.index + 1, Math.max(0.75, section));
        // Vào điệp khúc: sàn nhảy sang hoạ tiết động + loé một phát đón cú bung
        this.floor.setPattern(this.pickFloorPattern(0.9));
        this.nextFloorBeat = beat.index + 16;
        this.floor.burst(0.7, moodHue);
      } else if (section < 0.6) {
        this.inClimax = false;
      }
      // PYRO DIRECTOR quyết định bắn gì mỗi beat theo năng lượng nhạc — biết
      // kìm ở buildup, dồn cho khoảnh khắc mạnh, chọn kiểu/vị trí đa dạng và
      // không bắn máy móc. energyRise = độ leo section so với beat trước.
      const energyRise = section - this.pyroLastSection;
      this.pyroLastSection = section;
      const cues = this.pyroDirector.cue({
        beat,
        level,
        section,
        drop,
        energyRise,
        inClimax: this.inClimax,
        inQuietSection: this.music.inQuietSection,
        beatConfidence: this.music.beatConfidence,
        mood,
        flameCount: this.flames.count,
      });
      for (const c of cues) {
        if (c.kind === "firework") {
          this.fireworks.spawn(c.pos, 1, { type: c.type, hue: c.hue });
        } else if (c.kind === "flame") {
          this.flames.fire(c.strength, c.which);
        } else if (c.kind === "spark") {
          this.frontSparks.fire(c.strength);
        } else {
          this.smokeJets.blast(c.strength);
        }
      }
      // Blinder trắng ấm chớp về khán giả đúng phách 1 điệp khúc
      if (this.inClimax && level > 0.12 && beat.index % 4 === 0) {
        this.blinderFlash = 1;
      }
      // Mỗi câu 8 beat đổi "look" — verse luân phiên moving head ↔ beam
      if (beat.index % 8 === 0) this.lookMode = (this.lookMode + 1) % 2;
      // Floor director: đổi hoạ tiết sàn mỗi ~4 ô nhịp (có jitter) theo năng lượng
      if (beat.index >= this.nextFloorBeat) {
        this.floor.setPattern(this.pickFloorPattern(this.vibe.intensity));
        this.nextFloorBeat = beat.index + 16 + Math.floor(Math.random() * 8);
      }
      if (this.choreoMove && beat.index >= this.choreoEndBeat) {
        this.choreoMove = null;
        this.players.forEach((p) => (p.choreoMove = null));
        // Nghỉ tự do một quãng rồi mới đồng diễn tiếp — jitter độ dài quãng
        // nghỉ theo năng lượng để nhịp đồng diễn không lặp máy móc
        const gap = section > 0.6 ? 16 : 28;
        this.nextChoreoBeat =
          beat.index + gap + Math.floor(Math.random() * 12);
      }
      // Tới hạn đồng diễn theo chu kỳ (đã jitter) — bốc điệu hợp thể loại +
      // năng lượng, dàn theo một đội hình ngẫu nhiên
      if (
        !this.choreoMove &&
        beat.index >= this.nextChoreoBeat &&
        this.players.size >= 3
      ) {
        this.startChoreo(beat.index, this.vibe.intensity);
      }
    }

    // Drop vừa nổ: confetti + pháo hoa + toàn bộ vòi lửa & CO2 + cả sàn bật nhảy
    if (drop > 0.9 && this.lastDropLevel <= 0.9) {
      this.confetti.burst(150);
      this.fireworks.spawn(new THREE.Vector3(0, 2.5, -4), 3);
      this.flames.fire(1.6);
      this.smokeJets.blast(1.6);
      this.frontSparks.fire(1.5);
      this.cutToWide();
      this.djJumpT = 0;
      this.players.forEach((p) => {
        if (p.onFloor) p.jump();
      });
      // Drop = cả sàn bật nhảy ĐỒNG LOẠT một điệu cực bốc — cú "unison" đanh
      // đúng khoảnh khắc bass bùng, tương phản hẳn với đoạn buildup vừa lắng
      this.startChoreo(this.beatIndex, 1, "unison");
      // Sàn loé trắng cả mặt rồi vào ô cờ chớp mạnh cho cú drop
      this.floor.burst(1, moodHue);
      this.floor.setPattern("checker");
      this.nextFloorBeat = this.beatIndex + 16;
      this.hype = Math.min(1, this.hype + 0.25);
    }
    this.lastDropLevel = drop;

    const spotlighting =
      this.spotlightPlayer !== null && performance.now() < this.spotlightUntil;
    if (!spotlighting) this.spotlightPlayer = null;

    // Mỗi 4 giây xếp lại hàng đầu theo điểm tương tác/donate
    this.reseatT += dt;
    if (this.reseatT >= 4) {
      this.reseatT = 0;
      this.updateFrontRow();
      this.updateRigs();
    }

    // Không có event "rời live" từ TikTok — ai im lặng quá lâu coi như đã
    // thoát: gỡ nhân vật khỏi sàn để không tồn đọng người ảo
    this.idleSweepT += dt;
    if (this.idleSweepT >= 5) {
      this.idleSweepT = 0;
      const cutoff = performance.now() - IDLE_REMOVE_MS;
      let podiumChanged = false;
      for (const p of [...this.players.values()]) {
        if (p.lastActive >= cutoff) continue;
        podiumChanged ||= p.onPodium;
        this.removePlayer(p);
      }
      if (podiumChanged) this.updatePodium();
    }

    // Người đang được camera zoom cận cảnh không bao giờ bị làm mờ/mất tên
    const focused =
      this.focusPlayer !== null && performance.now() < this.focusUntil
        ? this.focusPlayer
        : null;
    this.players.forEach((p) => {
      p.setDimmed(
        spotlighting && p !== this.spotlightPlayer && p !== focused,
      );
      if (!p.onPodium) {
        switch (this.rules.zoneMode) {
          case "all-floor":
            if (!p.onFloor) {
              this.promoteToFloor(p);
              p.startDancing(Number.POSITIVE_INFINITY);
            }
            break;
          case "all-audience":
            if (p.onFloor) this.demoteToAudience(p);
            break;
          default:
            // Auto: chỉ người đã chat lệnh (floorEligible) mới được lên sàn —
            // quà/follow không tự kéo người chưa chat lên
            if (p.isDancing && p.floorEligible && !p.onFloor)
              this.promoteToFloor(p);
            else if (!p.isDancing && p.onFloor) this.demoteToAudience(p);
        }
      }
      p.update(
        dt,
        effHype,
        beat,
        this.music.playing,
        level,
        mEnergy,
        this.vibe,
        this.camera.position,
      );
    });
    const mid = this.music.playing ? this.music.mid : 0;
    // Mật độ khói quyết định beam rực cỡ nào — có khói beam mới hiện rõ
    const haze = this.smokeJets.density;

    // ĐẠO DIỄN ĐÈN RỌI — không auto bật cả dàn suốt bài: đoạn trầm tắt
    // beam gần hết, verse luân phiên nhóm (moving head ↔ beam) theo câu
    // 8 beat, chỉ điệp khúc mới lên full dàn
    const sec = this.music.section;
    let beamT: number;
    let mhT: number;
    let clubT: number;
    if (!this.music.playing) {
      beamT = 0.4;
      mhT = 0.4;
      clubT = 0.65;
    } else if (sec > 0.7) {
      beamT = 1;
      mhT = 1;
      clubT = 1;
    } else if (sec < 0.35 || this.music.inQuietSection) {
      beamT = 0;
      mhT = 0.22;
      clubT = 0.35;
    } else {
      beamT = this.lookMode === 0 ? 0.25 : 1;
      mhT = this.lookMode === 0 ? 1 : 0.3;
      clubT = 0.7;
    }
    const actK = Math.min(1, dt * 1.8);
    this.beamAct += (beamT - this.beamAct) * actK;
    this.mhAct += (mhT - this.mhAct) * actK;
    this.clubAct += (clubT - this.clubAct) * actK;

    this.floor.update(dt, effHype, beat, level, this.music.playing, mood);
    this.ledWall.update(dt, effHype, beat, level, this.music.playing, mid, mood);
    this.beams.update(
      dt,
      effHype,
      beat,
      level,
      this.music.playing,
      mood,
      haze,
      this.beamAct,
    );
    this.ball.update(dt, effHype, mEnergy);
    this.clubLights.update(
      dt,
      effHype,
      beat,
      level,
      this.music.playing,
      mood,
      this.clubAct,
    );
    this.speakers[0].update(dt, effHype, beat);
    this.speakers[1].update(dt, effHype, beat);
    this.fireworks.update(dt);
    this.confetti.update(dt, effHype);
    // Đoạn trầm/breakdown hoặc bài buồn: khói haze mỏng bò chậm quanh sân
    // khấu — beam đèn hiện rõ trong khói đúng chất club thật
    if (this.music.playing) {
      // Haze dày dần LIÊN TỤC theo độ trầm của đoạn (1 - section) + bài buồn,
      // thay vì bật/tắt theo ngưỡng nhị phân (gây chập chờn). density của
      // SmokeJets tan chậm nên khói luôn liền mạch.
      const quietAmt = Math.max(0, 1 - this.music.section * 1.4);
      const hazeRate =
        quietAmt * 2.4 + (1 - valence) * (1 - mEnergy) * 1.6 + 0.12;
      if (Math.random() < hazeRate * dt) this.smokeJets.puff();
    } else if (this.showcaseMode || this.demoRunning) {
      // Trang preview/demo chưa bật nhạc: xoay vòng lửa → CO2 → pháo hoa
      // mỗi ~2.5s + haze nhẹ, để thấy đủ bộ hiệu ứng mà không cần chờ nhạc
      this.showcasePyroT += dt;
      if (this.showcasePyroT >= 2.5) {
        this.showcasePyroT = 0;
        this.showcaseFxIdx = (this.showcaseFxIdx + 1) % 4;
        if (this.showcaseFxIdx === 0) this.flames.fire(1.1);
        else if (this.showcaseFxIdx === 1) this.frontSparks.fire(1);
        else if (this.showcaseFxIdx === 2) this.smokeJets.blast(1);
        else
          this.fireworks.spawn(
            new THREE.Vector3((Math.random() - 0.5) * 10, 4, -7),
            2,
          );
      }
      if (Math.random() < dt * 0.8) this.smokeJets.puff();
    }
    this.flames.update(dt);
    this.smokeJets.update(dt);
    this.frontSparks.update(dt);
    this.pyroDirector.update(dt);
    // Sương sàn: mật độ LIÊN TỤC theo độ trầm (1 - section) thay vì bật/tắt
    // theo ngưỡng (gây chập chờn) — dày ở verse/đoạn lắng, loãng dần vào điệp
    // khúc. GroundFog còn làm mượt thêm bên trong nên fade rất êm.
    const fogQuiet = !this.music.playing
      ? 0.7
      : Math.max(0, 1 - this.music.section * 1.4);
    this.groundFog.update(dt, fogQuiet, mEnergy, mood);
    // Bảng tên: đồng bộ nội dung/phông từ settings (rẻ, bỏ qua nếu không đổi)
    this.stageBanner.setText(
      this.rules.stageBannerText,
      this.rules.stageBannerStyle,
    );
    this.stageBanner.update(dt, beat, mEnergy);
    this.infoScreens.update(dt, this.music.progress);
    this.updateBanners(dt);

    // Ánh sáng nền + bầu trời nhuộm theo tâm trạng — đổi từ từ như kéo dimmer
    this.moodColor.setHSL(moodHue, 0.4, 0.6);
    this.ambient.color.lerp(this.moodColor, Math.min(1, dt * 0.8));
    this.ambient.intensity +=
      (0.36 + valence * 0.22 + mEnergy * 0.08 - this.ambient.intensity) *
      Math.min(1, dt * 0.8);
    this.keyLight.intensity +=
      (0.25 + valence * 0.2 - this.keyLight.intensity) * Math.min(1, dt * 0.8);
    this.moodColor.setHSL(moodHue, 0.55, 0.025 + valence * 0.012);
    (this.scene.background as THREE.Color).lerp(
      this.moodColor,
      Math.min(1, dt * 0.6),
    );
    this.scene.fog?.color.copy(this.scene.background as THREE.Color);

    const kick = Math.max(0, 1 - beat.pulse * 3);
    // Cả khối sân khấu nhún rất nhẹ theo kick + đung đưa theo bass
    const stageBobTarget = this.music.playing ? kick * 0.06 + level * 0.04 : 0;
    this.stageGroup.position.y +=
      (stageBobTarget - this.stageGroup.position.y) * Math.min(1, dt * 14);
    const stageSwayTarget = this.music.playing
      ? Math.sin(t * 1.9) * level * 0.05
      : 0;
    this.stageGroup.position.x +=
      (stageSwayTarget - this.stageGroup.position.x) * Math.min(1, dt * 8);
    // DJ "sống" theo đoạn nhạc: đổi frame skin mỗi beat, đoạn trầm cúi
    // người chỉnh mixer + hay chạy tới bàn đĩa, điệp khúc ngửa người quẩy
    // hết cỡ, drop thì bật nhảy; thi thoảng scratch đĩa như DJ thật
    if (this.music.playing && beat.index !== this.djLastBeat) {
      this.djLastBeat = beat.index;
      if (Math.random() < 0.22) this.djFacing = -this.djFacing;
      if (Math.random() < 0.3) this.djXTarget = (Math.random() - 0.5) * 1.7;
      // Scratch: nhạc có mid dày (vocal/synth) → 6% mỗi beat chạy tới một
      // bàn đĩa và kéo đĩa tới lui ~0.9s
      if (
        this.djScratchT < 0 &&
        this.music.mid > 0.22 &&
        Math.random() < 0.06
      ) {
        this.djScratchT = 0;
        this.djScratchDeck = Math.random() < 0.5 ? 0 : 1;
        this.djXTarget = this.djScratchDeck === 0 ? -1.45 : 1.45;
      }
    }
    if (this.djScratchT >= 0) {
      this.djScratchT += dt;
      if (this.djScratchT > 0.9) this.djScratchT = -1;
    }
    // DJ vẫy tay theo nhạc: bước khung LIÊN TỤC qua bộ pose (mượt hơn hẳn kiểu
    // 1 khung/phách), nhanh dần ở điệp khúc
    if (this.music.playing && this.djFrames.length > 1) {
      const fpb = 2.4 + sec * 1.6;
      const nf = this.djFrames.length;
      const idx =
        (((Math.floor((beat.index + beat.pulse) * fpb) % nf) + nf) % nf) | 0;
      if (idx !== this.djFrame) {
        this.djFrame = idx;
        this.djSprite.material.map = this.djFrames[idx];
        this.djSprite.material.needsUpdate = true;
      }
    }
    this.djX += (this.djXTarget - this.djX) * Math.min(1, dt * 3.5);
    this.djFacingCur += (this.djFacing - this.djFacingCur) * Math.min(1, dt * 9);
    const djF =
      Math.abs(this.djFacingCur) < 0.08
        ? this.djFacingCur < 0
          ? -0.08
          : 0.08
        : this.djFacingCur;
    // Pump nhẹ cả người theo kick — như đang "ăn" bass
    const djPump = this.music.playing ? 1 + kick * 0.05 * (0.5 + sec) : 1;
    this.djSprite.scale.set(this.djW * djF, 2.125 * djPump, 1);
    // Đoạn trầm: cúi về bàn mixer; điệp khúc: ngửa người về phía đám đông
    const djLeanT = !this.music.playing
      ? 0
      : this.djScratchT >= 0 || sec < 0.35
        ? 0.16
        : this.inClimax
          ? -0.12
          : 0;
    this.djLean += (djLeanT - this.djLean) * Math.min(1, dt * 4);
    const strongBeat = this.beatIndex % 4 === 0 ? 1.5 : 1;
    // Groove đưa người qua-lại theo swing 2 phách — chuyển động mượt liên tục
    const djGroove = this.music.playing
      ? Math.sin(((this.beatIndex % 2) + beat.pulse) * Math.PI) *
        (0.1 + sec * 0.14)
      : 0;
    this.djSprite.position.x = this.djX + djGroove;
    // Nhún dịu ở verse, quẩy hết biên độ ở điệp khúc
    this.djSprite.position.y =
      this.djBaseY + kick * 0.3 * strongBeat * (0.55 + sec * 0.9);
    if (this.djJumpT >= 0) {
      this.djJumpT += dt / 0.7;
      if (this.djJumpT >= 1) this.djJumpT = -1;
      else
        this.djSprite.position.y += Math.sin(this.djJumpT * Math.PI) * 0.85;
    }
    this.djSprite.material.rotation = this.music.playing
      ? Math.sin(t * 2.4) * 0.05 +
        Math.sin(beat.pulse * Math.PI * 2) * 0.09 * (0.6 + sec * 0.8) +
        this.djLean
      : Math.sin(t * 1.2) * 0.03;
    if (this.music.playing) {
      this.decks.forEach((d, i) => {
        if (this.djScratchT >= 0 && i === this.djScratchDeck) {
          // Kéo đĩa tới lui — platter quay giật ngược xuôi
          d.rotation.y += Math.sin(t * 26) * dt * 9;
        } else {
          d.rotation.y += dt * (2 + effHype * 6);
        }
      });
    }
    this.movingHeads.forEach(({ yoke, head, dir }, i) => {
      const panTarget = this.music.playing ? (this.mhPan[i] ?? 0) : 0;
      yoke.rotation.y += (panTarget - yoke.rotation.y) * Math.min(1, dt * 6);
      // Nốt thăng: beam ngẩng dần lên; nốt trầm: chúc xuống sàn
      const tiltTarget = this.music.playing
        ? dir * (0.3 + Math.sin(t * 0.33 + i * 1.7) * 0.32 +
            this.vibe.melodyTrend * 0.12)
        : dir * 0.1;
      head.rotation.x += (tiltTarget - head.rotation.x) * Math.min(1, dt * 3);
      const mhMat = this.movingHeadBeams[i];
      // Beam moving head nhuộm theo tâm trạng, nhạc êm thì mờ dịu lại
      this.moodColor.setHSL((moodHue + i * 0.12) % 1, 0.9, 0.6);
      mhMat.color.lerp(this.moodColor, Math.min(1, dt * 1.5));
      mhMat.opacity = this.music.playing
        ? (0.035 + level * 0.1 + kick * level * 0.08) *
          (0.55 + mEnergy * 0.75) *
          (0.4 + haze * 0.85) *
          (0.1 + this.mhAct * 0.9)
        : 0;
    });
    // Blinder tắt nhanh sau mỗi cú chớp
    this.blinderFlash = Math.max(0, this.blinderFlash - dt * 4);
    this.blinderMat.opacity = this.blinderFlash * 0.75;
    // Đèn rọi trời ở rìa venue quét qua lại chậm rãi
    this.beacons.forEach((b, i) => {
      b.rotation.z = Math.sin(t * 0.13 + i * 1.7) * 0.28;
      b.rotation.x = Math.sin(t * 0.09 + i * 1.1) * 0.18;
    });
    this.boothLeds.forEach((mat, i) => {
      const hue = (moodHue + i * 0.06 + this.beatIndex * 0.02) % 1;
      const bright = this.music.playing
        ? Math.min(0.62, (0.22 + level * 0.5 + kick * 0.18) * (0.55 + mEnergy * 0.6))
        : 0.1;
      mat.color.setHSL(hue, 0.9, bright);
    });
    // Drop: strobe nhấp nháy nhanh vài giây cho cảm giác bùng nổ;
    // nhạc êm/buồn thì strobe gần như tắt hẳn — dịu hơn để không chói
    const dropFlicker = drop > 0.05 ? (Math.sin(t * 42) > 0 ? 1 : 0.15) : 0;
    (this.strobe.material as THREE.MeshBasicMaterial).opacity =
      kick *
        (0.04 + level * 0.28 + effHype * 0.12) *
        (0.3 + mEnergy * 0.9) *
        gLight.strobe +
      drop * 0.22 * dropFlicker;
    this.npScreen.paused = !this.music.playing;
    this.npScreen.update(dt, this.music.getSpectrum(), beat, this.music.progress);

    this.followBlend +=
      ((spotlighting ? 1 : 0) - this.followBlend) * Math.min(1, dt * 5);
    if (this.spotlightPlayer) {
      const pos = this.spotlightPlayer.group.position;
      this.followSpotTarget.position.lerp(
        new THREE.Vector3(pos.x, pos.y + 1, pos.z),
        Math.min(1, dt * 9),
      );
    }
    this.followSpot.intensity = this.followBlend * 150;
    this.followBeam.visible = this.followBlend > 0.02;
    if (this.followBeam.visible) {
      const dir = new THREE.Vector3()
        .subVectors(this.followSpotTarget.position, this.followBeam.position)
        .normalize();
      this.followBeam.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, -1, 0),
        dir,
      );
      const dist = this.followBeam.position.distanceTo(
        this.followSpotTarget.position,
      );
      this.followBeam.scale.set(1, dist / 12 + 0.15, 1);
      // Tia mảnh + nhạt để không lóa nhân vật đang được spotlight
      (this.followBeam.material as THREE.MeshBasicMaterial).opacity =
        this.followBlend * (0.05 + kick * 0.02);
    }

    const focusing =
      this.focusPlayer !== null && performance.now() < this.focusUntil;
    this.focusBlend +=
      ((focusing ? 1 : 0) - this.focusBlend) * Math.min(1, dt * 2.5);
    if (!focusing && this.focusBlend < 0.01) this.focusPlayer = null;

    // ĐẠO DIỄN CAMERA — như người quay phim concert chuyên nghiệp:
    // - Đổi góc đúng RANH GIỚI CÂU NHẠC (bội số 8 beat), không theo đồng hồ
    // - Điệp khúc: take ngắn 8 beat, thi thoảng CẮT THẲNG; verse: take 16
    //   beat lướt vừa; đoạn trầm: take dài, chỉ góc rộng/đám đông
    // - Trong take máy không đứng yên: push-in chậm về sân khấu hoặc slide
    //   ngang như chạy trên ray
    const shots =
      this.rules.cameraMode === "orbit" ? ORBIT_SHOTS : FRONT_SHOTS;
    // Chế độ Thủ công: bật camera tự do (chuột điều khiển); rời chế độ thì
    // trả về đạo diễn tự động
    const manual = this.rules.cameraMode === "manual";
    if (manual) {
      if (!this.freeCam) this.enterFreeCam();
    } else if (this.freeCam) {
      this.unlockCamera();
    }
    // Toàn cảnh cố định hoặc thủ công (cameraLocked): ngưng tự cắt góc
    const fixedView =
      this.rules.cameraMode === "overview" || this.cameraLocked;
    this.takeT += dt;
    const sectionNow = this.music.section;
    if (fixedView) {
      // Không tự đổi góc
    } else if (this.music.playing) {
      if (beat.index !== this.camLastBeat) {
        this.camLastBeat = beat.index;
        this.takeBeats++;
        if (this.takeBeats >= this.takeLen && beat.index % 8 === 0) {
          const hot = sectionNow > 0.7;
          const calm = sectionNow < 0.4;
          // Nhóm góc theo không khí đoạn nhạc:
          // - trầm/intro: góc rộng, đám đông, trên cao — dựng cảnh thong thả
          // - điệp khúc/drop: góc động (cận, DJ, cánh, trên) + cắt nhanh
          // - verse: đa dạng vừa phải
          const kinds: CamShot["kind"][] = hot
            ? ["wide", "dj", "side", "close", "top", "medium", "low"]
            : calm
              ? ["wide", "crowd", "top", "medium"]
              : ["wide", "medium", "side", "top", "crowd", "dj", "close", "low"];
          this.switchShot(shots, {
            cut: hot && Math.random() < 0.5,
            energy: mEnergy,
            kinds,
          });
          // Độ dài take: điệp khúc cắt nhanh (kiểu MV), verse vừa, trầm dài vừa
          // phải (không để đứng một góc quá lâu). Lệch ±2 beat cho tự nhiên.
          const jitter = Math.floor(Math.random() * 5) - 2;
          this.takeLen = (hot ? 8 : calm ? 18 : 14) + jitter;
        }
      }
    } else if (this.takeT >= 13) {
      // Chưa phát nhạc: fallback đổi góc theo thời gian
      this.switchShot(shots, { energy: 0.4 });
      this.takeLen = 16;
    }
    if (this.freeCam) {
      // Camera tự do: dựng vị trí từ toạ độ cầu quanh điểm ngắm (mọi hướng)
      const cp = Math.cos(this.fcPitch);
      const sp = Math.sin(this.fcPitch);
      this.camShotPos.set(
        this.fcTarget.x + this.fcRadius * cp * Math.sin(this.fcYaw),
        this.fcTarget.y + this.fcRadius * sp,
        this.fcTarget.z + this.fcRadius * cp * Math.cos(this.fcYaw),
      );
      // Chặn cứng không cho máy tụt xuống dưới mặt sàn (thấy gầm sân khấu)
      this.camShotPos.y = Math.max(0.8, this.camShotPos.y);
      this.camShotLook.copy(this.fcTarget);
      this.camBaseFov = 55;
    } else {
      const shot =
        this.rules.cameraMode === "overview"
          ? OVERVIEW_SHOT
          : shots[this.shotIdx % shots.length];
      this.camBaseFov = FOV_BY_KIND[shot.kind];
      // Dolly trong take: ease mượt suốt ~11s, kèm rung thở rất nhẹ
      const takeProg = Math.min(1, this.takeT / 11);
      const takeEase = takeProg * takeProg * (3 - 2 * takeProg);
      this.camShotLook.set(shot.look[0], shot.look[1], shot.look[2]);
      // Cận/trung cảnh: khung ngắm bám CHỦ THỂ thật (chiều cao theo cỡ nhân
      // vật) thay vì điểm cố định — luôn có người trong khung
      const tracks = shot.kind === "close" || shot.kind === "medium";
      if (tracks && this.camSubject && this.camSubject.onFloor) {
        const g = this.camSubject.group;
        const sp = g.position;
        const h = 1.15 * Math.max(0.6, g.scale.y || 1);
        this.camShotLook.set(sp.x, sp.y + h, sp.z);
      } else if (!tracks) {
        this.camSubject = null;
      }
      // Trôi rất nhẹ, tần số THẤP (thở) — không rung. Bỏ dao động nhanh cũ.
      this.camShotPos.set(
        shot.pos[0] + Math.sin(t * 0.13) * 0.4 * shot.drift,
        shot.pos[1] + Math.sin(t * 0.09) * 0.2 * shot.drift,
        shot.pos[2] + Math.sin(t * 0.07) * 0.35 * shot.drift,
      );
      if (this.camMoveMode === "push") {
        // Đẩy máy từ từ về phía điểm nhìn. Cận/trung cảnh bám người thì đẩy ÍT
        // để không trườn sát mặt (zoom quá gần); góc rộng đẩy nhiều hơn cho đã
        this.camShotPos.lerp(this.camShotLook, takeEase * (tracks ? 0.07 : 0.14));
      } else {
        // Slide ngang vuông góc trục nhìn, từ mép này sang mép kia của take
        const dx = this.camShotLook.x - this.camShotPos.x;
        const dz = this.camShotLook.z - this.camShotPos.z;
        const len = Math.hypot(dx, dz) || 1;
        const amp = 2.4 * shot.drift * (takeEase * 2 - 1);
        this.camShotPos.x += (-dz / len) * amp;
        this.camShotPos.z += (dx / len) * amp;
      }
    }
    if (this.camCut) {
      // Hard cut: nhảy thẳng sang góc mới trong một frame
      this.camCut = false;
      this.camPos.copy(this.camShotPos);
      this.camLook.copy(this.camShotLook);
    } else {
      // Làm mượt kiểu hàm mũ (độc lập FPS) — lia máy êm, không khựng/giật
      const camK = 1 - Math.exp(-dt * this.camGlide * 3.2);
      this.camPos.lerp(this.camShotPos, camK);
      this.camLook.lerp(this.camShotLook, camK);
    }
    const focusingCam = this.focusPlayer && this.focusBlend > 0.01;
    if (focusingCam && this.focusPlayer) {
      const g = this.focusPlayer.group;
      const target = g.position;
      const b = this.focusBlend;
      // QUAN TRỌNG: khung theo KÍCH THƯỚC THẬT của nhân vật. Người được quà
      // thường bị grow (×1.9) hoặc đứng podium (×1.4) nên rất to — khoảng cách
      // cố định cũ (z+6) khiến máy dí sát tràn khung. Lùi xa theo chiều cao.
      const s = Math.max(0.4, g.scale.y || 1);
      const charH = 1.9 * s;
      const dist = 4.2 + charH * 1.7; // càng to càng lùi để lọt trọn người
      const lookY = target.y + charH * 0.55; // ngắm giữa thân, chừa headroom
      const camY = lookY + charH * 0.14;
      this.camera.position.set(
        this.camPos.x * (1 - b) + target.x * 0.5 * b,
        this.camPos.y * (1 - b) + camY * b,
        this.camPos.z * (1 - b) + (target.z + dist) * b,
      );
      this.lookTarget.set(
        this.camLook.x * (1 - b) + target.x * b,
        this.camLook.y * (1 - b) + lookY * b,
        this.camLook.z * (1 - b) + target.z * b,
      );
    } else {
      this.camera.position.copy(this.camPos);
      this.lookTarget.copy(this.camLook);
    }
    // Khung CHẮC, chân trời thẳng — không rung tay, không nghiêng máy.
    this.camera.lookAt(this.lookTarget);

    // Bloom "thở" theo kick của bass, bùng thêm khi drop; giữ mức thấp để
    // không lóa — glow chỉ nhấn nhá chứ không rửa trắng cả khung hình
    this.bloom.strength =
      0.22 + mEnergy * 0.16 + effHype * 0.22 + kick * level * 0.25 + drop * 0.25;
    // Ống kính theo loại khung + punch-in theo kick cho cảm giác dồn nhịp.
    // Focus KHÔNG punch (nếu không sẽ zoom sát thêm khi đang có action).
    const punch = kick * level * (2 + mEnergy * 2.5) + drop * 2;
    // Focus: ống kính cố định 46° + KHÔNG punch → khung ổn định, không zoom sát
    // thêm khi nhân vật đang có action (grow/podium)
    const baseVFov = focusingCam ? 46 : this.camBaseFov - punch;
    // Bù khung DỌC (TikTok 9:16): FOV của three.js là FOV DỌC — khung càng hẹp
    // ngang thì tầm nhìn ngang càng bị bóp, cắt mất hai bên sân khấu. Giữ NGUYÊN
    // khung NGANG như thiết kế cho 16:9 rồi suy ngược FOV dọc theo aspect thực;
    // chặn trần 94° để khung siêu dọc không méo fisheye.
    const hFov = 2 * Math.atan(Math.tan((baseVFov / 2) * DEG_R) * REF_ASPECT);
    let targetFov =
      (2 * Math.atan(Math.tan(hFov / 2) / Math.max(0.4, this.camera.aspect))) /
      DEG_R;
    targetFov = Math.min(Math.max(targetFov, baseVFov), 94);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 10);
    this.camera.updateProjectionMatrix();
    this.composer.render();
  };

  get hypeLevel() {
    return this.hype;
  }

  resize() {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    if (!parent) return;
    const { clientWidth: w, clientHeight: h } = parent;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    // Bloom vốn là hiệu ứng mờ — chạy ở nửa độ phân giải không khác gì
    // về hình nhưng giảm hẳn tải GPU (phải gọi SAU composer.setSize)
    this.bloom.setSize(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("wheel", this.onWheel);
    el.removeEventListener("dblclick", this.onDblClick);
    this.reset();
    this.renderer.dispose();
  }
}

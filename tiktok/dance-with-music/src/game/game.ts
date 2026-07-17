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
  Fireworks,
  FlameJets,
  LedWall,
  LightBeams,
  lerpHue,
  SmokeJets,
  SpeakerStack,
} from "./effects";
import { MusicPlayer } from "./music";
import {
  ALL_DANCE_MOVES,
  GENRE_MOVES,
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
// TikTok không có event "rời live" — user im lặng quá lâu coi như đã thoát
const IDLE_REMOVE_MS = 4 * 60_000;

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
  kind: "wide" | "medium" | "crowd" | "top" | "side" | "close";
};
const FRONT_SHOTS: CamShot[] = [
  // Toàn cảnh chính diện — thấy cả khán giả lẫn sân khấu
  { pos: [0, 6.2, 23.5], look: [0, 1.8, -2.5], drift: 1, kind: "wide" },
  // Chếch trái/phải hạ thấp — có chiều sâu
  { pos: [-6.5, 4.4, 20], look: [1.5, 1.9, -3], drift: 0.8, kind: "medium" },
  { pos: [6.5, 4.4, 20], look: [-1.5, 1.9, -3], drift: 0.8, kind: "medium" },
  // Giữa đám đông nhìn lên sân khấu
  { pos: [0, 3.4, 18.5], look: [0, 2.4, -4], drift: 0.6, kind: "crowd" },
  // Trên cao chếch xuống toàn sàn
  { pos: [0, 10, 20], look: [0, 1, -3], drift: 0.7, kind: "top" },
  // Thẳng từ trên xuống — bird's eye toàn bộ sàn nhảy
  { pos: [0, 16.5, 3], look: [0, 0.5, -2.5], drift: 0.5, kind: "top" },
  // Cánh trái/phải nhìn ngang qua sàn
  { pos: [-15.5, 5.5, 12], look: [3, 1.8, -2.5], drift: 0.9, kind: "side" },
  { pos: [15.5, 5.5, 12], look: [-3, 1.8, -2.5], drift: 0.9, kind: "side" },
];
const ORBIT_SHOTS: CamShot[] = [
  ...FRONT_SHOTS,
  // Sát mép sàn nhìn chéo lên sân khấu
  { pos: [-12, 4.2, 1.5], look: [4, 2.1, -6.5], drift: 0.7, kind: "close" },
  { pos: [12, 4.2, 1.5], look: [-4, 2.1, -6.5], drift: 0.7, kind: "close" },
];
const STAGE_H = 0.9;
const AUDIENCE_Y = -0.35;
const AUDIENCE_Z0 = FLOOR_D / 2 + 0.5;

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
  // Object dùng chung truyền xuống mọi Player mỗi frame (tránh cấp phát mới)
  private vibe: MusicVibe = { genre: "pop", melodyTrend: 0, melodyHeight: 0.5 };
  // Đồng diễn: cứ 32 beat cả sàn cùng nhảy một điệu trong 8 beat
  private choreoMove: DanceMove | null = null;
  private choreoEndBeat = 0;
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
  private camPos = new THREE.Vector3(0, 6.2, 23.5);
  private camLook = new THREE.Vector3(0, 1.8, -2.5);
  private camShotPos = new THREE.Vector3();
  private camShotLook = new THREE.Vector3();

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
    this.ledWall = new LedWall(FLOOR_W + 8, 8, -FLOOR_D / 2 - 2.4);
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
    );
    this.stageGroup.add(
      this.ledWall.mesh,
      this.speakers[0].group,
      this.speakers[1].group,
    );

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);

    this.resize();
    this.loop();
  }

  private onPointerDown = (e: PointerEvent) => {
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

    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(FLOOR_W + 8, 0.5, 3.4),
      new THREE.MeshStandardMaterial({
        color: 0x0d1020,
        metalness: 0.4,
        roughness: 0.7,
      }),
    );
    deck.position.set(0, AUDIENCE_Y - 0.25, AUDIENCE_Z0 + 0.8);
    this.scene.add(deck);

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

    const starCount = 260;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 1] = 3 + Math.random() * 15;
      positions[i * 3 + 2] = -6 - Math.random() * 28;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0x46507a, size: 0.08 }),
    );
    this.scene.add(stars);

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
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 18; c++) {
        this.audienceSlotsFree.push(
          new THREE.Vector3(
            (c + 0.5 - 9) * 1.55 + (Math.random() - 0.5) * 0.4,
            AUDIENCE_Y,
            AUDIENCE_Z0 + r * 0.7 + (Math.random() - 0.5) * 0.25,
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

  private promoteToFloor(player: Player) {
    const pos = this.takeSlot("floor");
    this.releaseSlot(player.user.userId);
    this.playerSlots.set(player.user.userId, { zone: "floor", pos });
    player.onFloor = true;
    player.setZone("floor");
    player.setHome(pos);
    if (!player.forcedMove) player.choreoMove = this.choreoMove;
  }

  private demoteToAudience(player: Player) {
    const pos = this.takeSlot("audience");
    this.releaseSlot(player.user.userId);
    this.playerSlots.set(player.user.userId, { zone: "audience", pos });
    player.onFloor = false;
    player.setZone("audience");
    player.setHome(pos);
    player.choreoMove = null;
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
    this.djDefaultW = 2.125 * dj.aspect;
    if (!this.djTakeover) {
      this.djSprite.material.map = this.djDefaultMap;
      this.djSprite.material.needsUpdate = true;
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

  /** Đổi sang góc máy mới — tránh lặp 2 shot gần nhất, lọc theo loại khung. */
  private switchShot(
    shots: CamShot[],
    opts: { kinds?: CamShot["kind"][]; cut?: boolean; energy: number },
  ) {
    let candidates = shots
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s, i }) =>
          i !== this.shotIdx &&
          i !== this.prevShotIdx &&
          (!opts.kinds || opts.kinds.includes(s.kind)),
      );
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
  }

  /** Cắt thẳng sang góc toàn cảnh — phản xạ của cameraman khi drop/vào điệp khúc. */
  private cutToWide() {
    const shots =
      this.rules.cameraMode === "orbit" ? ORBIT_SHOTS : FRONT_SHOTS;
    this.switchShot(shots, { kinds: ["wide", "top"], cut: true, energy: 1 });
    this.takeLen = 8;
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
      player.startDancing(
        r.stayOnFloor ? Number.POSITIVE_INFINITY : r.danceStartSec * 1000,
      );
    }

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
        if (!isStart) player.say(event.comment);
        break;
    }
    player.score += 1;
    this.hype = Math.min(1, this.hype + 0.015);
  }

  handleGift(event: GiftEvent) {
    const player = this.ensurePlayer(event.user);
    player.celebrate();
    const bursts = Math.min(
      6,
      1 + Math.floor((event.diamondCount * event.repeatCount) / 100),
    );
    this.confetti.burst(30 + bursts * 20);
    this.showBanner(
      `🎁 ${event.user.nickname} tặng ${event.giftName} ×${event.repeatCount}` +
        (event.totalDiamonds > 0 ? ` 💎${event.totalDiamonds}` : ""),
    );

    // Cộng 💎 TRƯỚC khi xử lý action — orderDj cần so tổng donate mới nhất
    if (!event.streaking) {
      player.diamonds += event.totalDiamonds;
      // Donate tính điểm nặng nhất — 1💎 = 5 điểm tương tác
      player.score += event.totalDiamonds * 5;
      this.updatePodium();
    }

    const value = event.diamondCount;
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
    this.hype = Math.min(1, this.hype + event.count * 0.014);
    const player = this.players.get(event.user.userId);
    if (player) {
      player.lastActive = performance.now();
      player.score += event.count * 0.05;
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
      beat = this.music.getBeat();
      this.beatIndex = beat.index;
    } else {
      beat = { index: this.beatIndex, pulse: 1 };
    }

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
        // Vào điệp khúc: cameraman cắt thẳng sang toàn cảnh đón cú bung
        this.cutToWide();
      } else if (section < 0.6) {
        this.inClimax = false;
      }
      if (this.inClimax && level > 0.12) {
        // Sparkular mặt tiền chạy suốt điệp khúc — mỗi phách một đợt tia
        this.frontSparks.fire(0.45 + level * 0.3);
        if (beat.index % 16 === 0) {
          this.pyroPattern = Math.floor(Math.random() * 3);
        }
        const n = this.flames.count;
        if (this.pyroPattern === 0) {
          // Lửa đuổi vòng quanh sàn — mỗi phách một vòi kế tiếp
          this.flames.fire(0.7 + level * 0.4, [beat.index % n]);
        } else if (this.pyroPattern === 1) {
          // Từ giữa (mép sân khấu) tỏa ra hai bên theo cặp, mỗi 2 phách
          if (beat.index % 2 === 0) {
            const pairs = [
              [2, 3],
              [1, 4],
              [0, 5],
            ];
            this.flames.fire(
              0.8 + level * 0.4,
              pairs[(beat.index >> 1) % pairs.length],
            );
          }
        } else if (beat.index % 4 === 0) {
          // Cả dàn dậm đúng phách 1 của mỗi ô nhịp
          this.flames.fire(0.9 + level * 0.5);
        }
        if (beat.index % 8 === 0) this.smokeJets.blast(0.5 + level * 0.4);
        // Điệp khúc thật căng: pháo hoa nổ sau sân khấu mỗi 4 ô nhịp
        if (beat.index % 16 === 8 && section > 0.8) {
          this.fireworks.spawn(
            new THREE.Vector3((Math.random() - 0.5) * 12, 4.5, -7),
            2,
          );
        }
      } else if (this.music.inQuietSection && beat.index % 2 === 0) {
        this.smokeJets.blast(0.22);
      }
      if (this.choreoMove && beat.index >= this.choreoEndBeat) {
        this.choreoMove = null;
        this.players.forEach((p) => (p.choreoMove = null));
      }
      if (!this.choreoMove && beat.index % 32 === 0 && this.players.size >= 3) {
        // Đồng diễn cũng chọn điệu hợp thể loại đang phát
        const pool = GENRE_MOVES[genre];
        this.choreoMove = pool[Math.floor(Math.random() * pool.length)];
        this.choreoEndBeat = beat.index + 8;
        this.players.forEach((p) => {
          if (p.onFloor && !p.forcedMove) p.choreoMove = this.choreoMove;
        });
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
      this.players.forEach((p) => {
        if (p.onFloor) p.jump();
      });
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
            if (p.isDancing && !p.onFloor) this.promoteToFloor(p);
            else if (!p.isDancing && p.onFloor) this.demoteToAudience(p);
        }
      }
      p.update(dt, effHype, beat, this.music.playing, level, mEnergy, this.vibe);
    });
    const mid = this.music.playing ? this.music.mid : 0;
    this.floor.update(dt, effHype, beat, level, this.music.playing, mood);
    this.ledWall.update(dt, effHype, beat, level, this.music.playing, mid, mood);
    this.beams.update(dt, effHype, beat, level, this.music.playing, mood);
    this.ball.update(dt, effHype, mEnergy);
    this.clubLights.update(dt, effHype, beat, level, this.music.playing, mood);
    this.speakers[0].update(dt, effHype, beat);
    this.speakers[1].update(dt, effHype, beat);
    this.fireworks.update(dt);
    this.confetti.update(dt, effHype);
    // Đoạn trầm/breakdown hoặc bài buồn: khói haze mỏng bò chậm quanh sân
    // khấu — beam đèn hiện rõ trong khói đúng chất club thật
    if (this.music.playing) {
      // Đoạn trầm (theo z-score của chính bài) hoặc bài buồn → haze dày hơn
      const hazeRate =
        (this.music.inQuietSection || this.music.section < 0.35 ? 2.4 : 0) +
        (1 - valence) * (1 - mEnergy) * 1.6 +
        0.1;
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
    // DJ quẩy: nhún theo kick (mạnh hơn mỗi 4 beat), đi qua lại sau bàn,
    // thi thoảng quay người, gật đầu theo nhịp
    if (this.music.playing && beat.index !== this.djLastBeat) {
      this.djLastBeat = beat.index;
      if (Math.random() < 0.22) this.djFacing = -this.djFacing;
      if (Math.random() < 0.3) this.djXTarget = (Math.random() - 0.5) * 1.7;
    }
    this.djX += (this.djXTarget - this.djX) * Math.min(1, dt * 3.5);
    this.djFacingCur += (this.djFacing - this.djFacingCur) * Math.min(1, dt * 9);
    const djF =
      Math.abs(this.djFacingCur) < 0.08
        ? this.djFacingCur < 0
          ? -0.08
          : 0.08
        : this.djFacingCur;
    this.djSprite.scale.x = this.djW * djF;
    const strongBeat = this.beatIndex % 4 === 0 ? 1.5 : 1;
    this.djSprite.position.x = this.djX;
    this.djSprite.position.y = this.djBaseY + kick * 0.3 * strongBeat;
    this.djSprite.material.rotation = this.music.playing
      ? Math.sin(t * 2.4) * 0.05 + Math.sin(beat.pulse * Math.PI * 2) * 0.09
      : Math.sin(t * 1.2) * 0.03;
    if (this.music.playing) {
      this.decks.forEach((d) => (d.rotation.y += dt * (2 + effHype * 6)));
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
        ? (0.035 + level * 0.1 + kick * level * 0.08) * (0.55 + mEnergy * 0.75)
        : 0;
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
    this.takeT += dt;
    const sectionNow = this.music.section;
    if (this.music.playing) {
      if (beat.index !== this.camLastBeat) {
        this.camLastBeat = beat.index;
        this.takeBeats++;
        if (this.takeBeats >= this.takeLen && beat.index % 8 === 0) {
          const hot = sectionNow > 0.7;
          const calm = sectionNow < 0.4;
          this.switchShot(shots, {
            kinds: hot
              ? undefined
              : calm
                ? ["wide", "crowd", "medium"]
                : ["wide", "medium", "side", "top", "crowd"],
            cut: hot && Math.random() < 0.5,
            energy: mEnergy,
          });
          this.takeLen = hot ? 8 : calm ? 24 : 16;
        }
      }
    } else if (this.takeT >= 13) {
      // Chưa phát nhạc: fallback đổi góc theo thời gian
      this.switchShot(shots, { energy: 0.4 });
      this.takeLen = 16;
    }
    const shot = shots[this.shotIdx % shots.length];
    // Dolly trong take: ease mượt suốt ~11s, kèm rung thở rất nhẹ
    const takeProg = Math.min(1, this.takeT / 11);
    const takeEase = takeProg * takeProg * (3 - 2 * takeProg);
    this.camShotLook.set(shot.look[0], shot.look[1], shot.look[2]);
    this.camShotPos.set(
      shot.pos[0] + Math.sin(t * 0.13) * 0.5 * shot.drift,
      shot.pos[1] +
        Math.sin(t * 0.09) * 0.25 * shot.drift +
        Math.sin(t * 5) * effHype * 0.04,
      shot.pos[2] + Math.sin(t * 0.07) * 0.4 * shot.drift,
    );
    if (this.camMoveMode === "push") {
      // Đẩy máy từ từ về phía điểm nhìn (~1/5 quãng đường mỗi take)
      this.camShotPos.lerp(this.camShotLook, takeEase * 0.2);
    } else {
      // Slide ngang vuông góc trục nhìn, từ mép này sang mép kia của take
      const dx = this.camShotLook.x - this.camShotPos.x;
      const dz = this.camShotLook.z - this.camShotPos.z;
      const len = Math.hypot(dx, dz) || 1;
      const amp = 2.4 * shot.drift * (takeEase * 2 - 1);
      this.camShotPos.x += (-dz / len) * amp;
      this.camShotPos.z += (dx / len) * amp;
    }
    if (this.camCut) {
      // Hard cut: nhảy thẳng sang góc mới trong một frame
      this.camCut = false;
      this.camPos.copy(this.camShotPos);
      this.camLook.copy(this.camShotLook);
    } else {
      const camK = Math.min(1, dt * this.camGlide);
      this.camPos.lerp(this.camShotPos, camK);
      this.camLook.lerp(this.camShotLook, camK);
    }
    if (this.focusPlayer && this.focusBlend > 0.01) {
      const target = this.focusPlayer.group.position;
      const b = this.focusBlend;
      const focusCamY = target.y + 2.6;
      const focusLookY = target.y + 1.2;
      this.camera.position.set(
        this.camPos.x * (1 - b) + target.x * 0.7 * b,
        this.camPos.y * (1 - b) + focusCamY * b,
        this.camPos.z * (1 - b) + (target.z + 6) * b,
      );
      this.lookTarget.set(
        this.camLook.x * (1 - b) + target.x * b,
        this.camLook.y * (1 - b) + focusLookY * b,
        this.camLook.z * (1 - b) + target.z * b,
      );
      this.camera.lookAt(this.lookTarget);
    } else {
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    }

    // Bloom "thở" theo kick của bass, bùng thêm khi drop; giữ mức thấp để
    // không lóa — glow chỉ nhấn nhá chứ không rửa trắng cả khung hình
    this.bloom.strength =
      0.22 + mEnergy * 0.16 + effHype * 0.22 + kick * level * 0.25 + drop * 0.25;
    // Camera punch-in nhẹ theo kick — cảm giác dồn nhịp như video ca nhạc
    const targetFov = 58 - kick * level * (2 + mEnergy * 2.5) - drop * 2;
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
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this.onPointerDown,
    );
    this.reset();
    this.renderer.dispose();
  }
}

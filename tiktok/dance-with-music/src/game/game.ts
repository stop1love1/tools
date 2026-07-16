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
  LedWall,
  LightBeams,
  SpeakerStack,
} from "./effects";
import { MusicPlayer } from "./music";
import { ALL_DANCE_MOVES, Player, type Beat } from "./player";
import { NowPlayingScreen } from "./screen";
import {
  generateSkins,
  loadCustomSkins,
  makeLabelTexture,
  type Skin,
} from "./skins";

const FLOOR_W = 28;
const FLOOR_D = 19;
const MAX_PLAYERS = 220;
const HYPE_DECAY_PER_S = 0.14;
const STAGE_H = 0.9;
// Khán đài phía trước-dưới: chỗ đứng xem của người chưa nhảy
const AUDIENCE_Y = -0.35;
const AUDIENCE_Z0 = FLOOR_D / 2 + 0.5;

type PodiumSlot = {
  pedestal: THREE.Mesh;
  label: THREE.Sprite;
  /** Vị trí đứng trên mặt bục — người donate top đứng thật ở đây. */
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
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;

  private skins: Skin[] = [];
  private players = new Map<string, Player>();
  private danceSlotsFree: THREE.Vector3[] = [];
  private audienceSlotsFree: THREE.Vector3[] = [];
  // Chỗ đứng hiện tại của từng người để trả lại pool khi rời đi/chuyển khu
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
  private podium: PodiumSlot[] = [];
  private banners: Banner[] = [];
  private djSprite!: THREE.Sprite;
  private djBaseY = 0;
  private decks: THREE.Mesh[] = [];
  // Các khối hộp tạm — sẽ bị thay khi model GLB thật load xong
  private boothParts: THREE.Object3D[] = [];
  private subwooferBoxes: THREE.Object3D[] = [];
  private strobe!: THREE.Mesh;
  private npScreen!: NowPlayingScreen;
  private raycaster = new THREE.Raycaster();
  /** Bấm nút ⏮⏯⏭ trên màn hình DJ (raycast) — HUD gắn handler. */
  onScreenControl: ((action: "prev" | "toggle" | "next") => void) | null = null;
  readonly music = new MusicPlayer();
  /** Luật chơi do admin cấu hình trong Settings. */
  rules: GameRules = DEFAULT_RULES;
  private hype = 0;

  // Camera zoom cận cảnh người donate lớn
  private focusPlayer: Player | null = null;
  private focusUntil = 0;
  private focusBlend = 0;
  private lookTarget = new THREE.Vector3();
  private orbitAngle = 0;

  // Nhịp nhạc toàn sàn
  private beatT = 0;
  private beatIndex = 0;

  private demoTimers: ReturnType<typeof setInterval>[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene.background = new THREE.Color(0x04050a);
    this.scene.fog = new THREE.Fog(0x04050a, 34, 78);

    // Khung hình chuẩn: sân khấu 1/3 trên, sàn nhảy giữa, khán đài mép dưới
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 200);
    this.camera.position.set(0, 7.2, 19.5);
    this.camera.lookAt(0, 1.8, -2.5);

    // Ánh sáng thật để vật thể 3D có khối
    this.scene.add(new THREE.AmbientLight(0x8890c0, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 0.5);
    key.position.set(4, 12, 10);
    this.scene.add(key);

    // Post-processing: bloom cho đèn neon/LED phát quang như club thật
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(1280, 720),
      0.45, // strength — tăng theo hype trong loop
      0.55, // radius
      0.82, // threshold — chỉ đèn/neon thật sáng mới glow, nhân vật không bị cháy
    );
    this.composer.addPass(this.bloom);

    this.skins = generateSkins();
    this.preuploadSkins(this.skins);
    this.buildStage();
    this.buildSlots();

    this.floor = new DiscoFloor(FLOOR_W, FLOOR_D, 20, 15);
    this.ledWall = new LedWall(FLOOR_W + 8, 8, -FLOOR_D / 2 - 2.4);
    this.speakers = [
      new SpeakerStack(-FLOOR_W / 2 - 1.6, -3),
      new SpeakerStack(FLOOR_W / 2 + 1.6, -3),
    ];
    this.scene.add(
      this.floor.mesh,
      this.ledWall.mesh,
      this.beams.group,
      this.ball.group,
      this.clubLights.group,
      this.speakers[0].group,
      this.speakers[1].group,
      this.fireworks.group,
      this.confetti.points,
    );

    // Click vào màn hình DJ trong khung 3D → nút ⏮⏯⏭
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
    if (action) this.onScreenControl?.(action);
  };

  /** Upload sẵn toàn bộ texture lên GPU để không khựng lúc đổi frame. */
  private preuploadSkins(skins: Skin[]) {
    for (const skin of skins) {
      for (const frame of skin.frames) {
        this.renderer.initTexture(frame);
      }
    }
  }

  // --- Scene setup ----------------------------------------------------------

  private buildStage() {
    // Nền tối lì dưới các ô gạch (đã bỏ mặt gương phản chiếu theo yêu cầu)
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

    // Vòm vũ trụ bao quanh sân khấu: tinh vân + sao vẽ bằng canvas
    const space = document.createElement("canvas");
    space.width = 2048;
    space.height = 1024;
    const sctx = space.getContext("2d")!;
    // Nền tím thẫm chuyển sắc thay vì đen tuyền
    const bgGrad = sctx.createLinearGradient(0, 0, 0, space.height);
    bgGrad.addColorStop(0, "#0a0620");
    bgGrad.addColorStop(0.5, "#120a2e");
    bgGrad.addColorStop(1, "#060418");
    sctx.fillStyle = bgGrad;
    sctx.fillRect(0, 0, space.width, space.height);

    // Dải ngân hà chéo vắt ngang trời
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

    // Tinh vân sáng nhiều lớp (đậm hơn hẳn)
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

    // Sao: dày hơn, sao sáng có quầng glow
    for (let i = 0; i < 2200; i++) {
      const b = Math.random();
      const x = Math.random() * space.width;
      const y = Math.random() * space.height;
      if (b > 0.965) {
        // Sao sáng: quầng glow + chữ thập lấp lánh
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

    // Sân khấu nổi phía sau cho bục top
    const stage = new THREE.Mesh(
      new THREE.BoxGeometry(23, STAGE_H, 4.2),
      new THREE.MeshStandardMaterial({
        color: 0x161a2c,
        metalness: 0.5,
        roughness: 0.5,
      }),
    );
    stage.position.set(0, STAGE_H / 2, -FLOOR_D / 2 + 0.4);
    this.scene.add(stage);

    // Viền neon mép sân khấu
    const lip = new THREE.Mesh(
      new THREE.BoxGeometry(23, 0.06, 0.08),
      new THREE.MeshBasicMaterial({ color: 0xfe2c55 }),
    );
    lip.position.set(0, STAGE_H, -FLOOR_D / 2 + 2.52);
    this.scene.add(lip);

    // Khán đài phía trước-dưới cho người chưa nhảy
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

    // Lan can neon ngăn khán đài với sàn nhảy
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

    // Bụi sáng lơ lửng cho có chiều sâu
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

    // Bàn DJ giữa sân khấu
    const booth = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 1.1, 1.1),
      new THREE.MeshStandardMaterial({
        color: 0x141828,
        metalness: 0.6,
        roughness: 0.4,
      }),
    );
    booth.position.set(0, STAGE_H + 0.55, -FLOOR_D / 2 + 0.2);
    const boothNeon = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 0.3, 0.05),
      new THREE.MeshBasicMaterial({ color: 0x25f4ee }),
    );
    boothNeon.position.set(0, STAGE_H + 0.42, -FLOOR_D / 2 + 0.78);
    this.scene.add(booth, boothNeon);
    this.boothParts.push(booth, boothNeon);
    for (const dx of [-0.85, 0.85]) {
      const deck = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, 0.06, 24),
        new THREE.MeshStandardMaterial({
          color: 0x2c3350,
          metalness: 0.8,
          roughness: 0.25,
        }),
      );
      deck.position.set(dx, STAGE_H + 1.14, -FLOOR_D / 2 + 0.2);
      this.scene.add(deck);
      this.decks.push(deck);
    }
    // DJ đầu nấm đứng sau bàn — nhún theo beat trong loop
    this.djBaseY = STAGE_H + 1.6;
    this.djSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.skins[3 % this.skins.length].frames[0],
        transparent: true,
      }),
    );
    this.djSprite.material.color.setScalar(0.72);
    this.djSprite.scale.set(1.5, 1.875, 1);
    this.djSprite.position.set(0, this.djBaseY, -FLOOR_D / 2 - 0.5);
    this.scene.add(this.djSprite);

    // Màn hình LED to phía trên DJ: tên bài nhạc + EQ
    this.npScreen = new NowPlayingScreen(
      9.5,
      3,
      new THREE.Vector3(0, 6.6, -FLOOR_D / 2 - 2.35),
    );
    this.scene.add(this.npScreen.mesh);

    // Strobe trắng sau lưng DJ, lóe theo beat
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
    this.scene.add(this.strobe);

    // Giàn truss hai bên + thanh ngang trên đỉnh cho giống sân khấu thật
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
      this.scene.add(tower);
    }
    const topBar = new THREE.Mesh(
      new THREE.BoxGeometry(FLOOR_W + 5.2, 0.35, 0.35),
      trussMat,
    );
    topBar.position.set(0, 11.8, -FLOOR_D / 2 + 1.2);
    this.scene.add(topBar);

    // Dàn đèn par gắn dọc thanh truss
    const parColors = [0xfe2c55, 0x25f4ee, 0xffc94d, 0x8a2be2];
    for (let i = 0; i < 9; i++) {
      const par = new THREE.Mesh(
        new THREE.BoxGeometry(0.35, 0.45, 0.35),
        new THREE.MeshBasicMaterial({ color: parColors[i % parColors.length] }),
      );
      par.position.set((i - 4) * (FLOOR_W / 9), 11.45, -FLOOR_D / 2 + 1.2);
      this.scene.add(par);
    }

    // (Không còn tường — sân khấu lơ lửng giữa vũ trụ)

    // Subwoofer chân sân khấu
    for (const x of [-8, -4, 0, 4, 8]) {
      const sub = new THREE.Mesh(
        new THREE.BoxGeometry(2.4, 0.95, 0.9),
        new THREE.MeshStandardMaterial({
          color: 0x101322,
          metalness: 0.4,
          roughness: 0.7,
        }),
      );
      sub.position.set(x, 0.48, -FLOOR_D / 2 + 2.95);
      this.scene.add(sub);
      this.subwooferBoxes.push(sub);
    }

    // Nạp model GLB thật (public/models) thay các khối hộp — chạy nền
    this.loadStageModels();

    // Bục top donate 1-2-3 hai bên bàn DJ — người donate top đứng THẬT trên bục
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

  /** Nạp model GLB miễn phí; thiếu model nào thì giữ khối hộp fallback. */
  private async loadStageModels() {
    const loader = new GLTFLoader();
    const tryLoad = (url: string) =>
      new Promise<THREE.Group | null>((resolve) =>
        loader.load(url, (g) => resolve(g.scene), undefined, () => resolve(null)),
      );
    // Scale model về chiều cao mong muốn, chân chạm y=0 của group
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

    // 2 dàn loa giữ bản dựng tay (màng loa đập theo beat) — không thay model
    const [sub, booth, spot] = await Promise.all([
      tryLoad("/models/subwoofer.glb"),
      tryLoad("/models/dj-booth.glb"),
      tryLoad("/models/spotlight.glb"),
    ]);
    if (this.disposed) return;

    if (sub) {
      this.subwooferBoxes.forEach((s) => this.scene.remove(s));
      for (const x of [-8, -4, 0, 4, 8]) {
        const clone = normalize(sub.clone(true), 1.0);
        clone.position.set(x, 0, -FLOOR_D / 2 + 2.95);
        this.scene.add(clone);
      }
    }
    if (booth) {
      this.boothParts.forEach((p) => this.scene.remove(p));
      this.decks.forEach((d) => this.scene.remove(d));
      this.decks = [];
      const clone = normalize(booth, 1.7);
      clone.position.set(0, STAGE_H, -FLOOR_D / 2 + 0.2);
      this.scene.add(clone);
    }
    if (spot) {
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const clone = normalize(spot.clone(true), 1.0);
        // Treo đúng trên vòng truss tròn (bán kính 6.2, tâm z=-2),
        // trùng vị trí gốc các beam đèn quét
        clone.position.set(
          Math.cos(angle) * 6.2,
          10.45, // đỉnh đèn chạm mép dưới ống truss (10.48)
          -2 + Math.sin(angle) * 6.2,
        );
        clone.rotation.x = Math.PI; // chúc đầu đèn xuống sàn
        this.scene.add(clone);
      }
    }
  }

  private buildSlots() {
    // Sàn nhảy: lưới dày, chừa sân khấu phía sau
    const cols = 17;
    const rows = 13;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.danceSlotsFree.push(
          new THREE.Vector3(
            (c + 0.5 - cols / 2) * (FLOOR_W / cols - 0.1) +
              (Math.random() - 0.5) * 0.6,
            0.1,
            (r + 2.2 - rows / 2) * ((FLOOR_D - 5) / rows) +
              (Math.random() - 0.5) * 0.4,
          ),
        );
      }
    }
    // Khán đài: 4 hàng phía trước-dưới
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
    // Hết chỗ xếp sẵn thì chen ngẫu nhiên trong khu
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
    // Chỗ trên bục DJ không thuộc pool nào
    if (ref.zone !== "podium") {
      (ref.zone === "floor"
        ? this.danceSlotsFree
        : this.audienceSlotsFree
      ).push(ref.pos);
    }
    this.playerSlots.delete(userId);
  }

  /** Chat "1" → được lên sàn; hết năng lượng nhảy → về khán đài xem. */
  private promoteToFloor(player: Player) {
    const pos = this.takeSlot("floor");
    this.releaseSlot(player.user.userId);
    this.playerSlots.set(player.user.userId, { zone: "floor", pos });
    player.onFloor = true;
    player.setZone("floor");
    player.setHome(pos);
  }

  private demoteToAudience(player: Player) {
    const pos = this.takeSlot("audience");
    this.releaseSlot(player.user.userId);
    this.playerSlots.set(player.user.userId, { zone: "audience", pos });
    player.onFloor = false;
    player.setZone("audience");
    player.setHome(pos);
  }

  // --- Skins ------------------------------------------------------------------

  async useCustomSkins(urls: string[]) {
    if (!urls.length) return;
    const custom = await loadCustomSkins(urls);
    if (!custom.length || this.disposed) return;
    this.preuploadSkins(custom);
    // CHỈ dùng meme thật từ public/characters — bộ tự vẽ chỉ là fallback
    // khi folder trống
    this.skins = custom;
    this.players.forEach((p) => p.setSkins(custom));
    // DJ cũng đổi sang skin meme
    const dj = custom[3 % custom.length];
    this.djSprite.material.map = dj.frames[0];
    this.djSprite.material.needsUpdate = true;
    this.djSprite.scale.set(1.875 * dj.aspect, 1.875, 1);
  }

  // --- Live event handlers ------------------------------------------------------

  private ensurePlayer(user: LiveUser): Player {
    let player = this.players.get(user.userId);
    if (!player) {
      if (this.players.size >= MAX_PLAYERS) this.evictOldest();
      // Người mới rơi từ trời xuống; khu vực theo zoneMode admin cấu hình
      const zone = this.rules.zoneMode === "all-floor" ? "floor" : "audience";
      const slot = this.takeSlot(zone);
      this.playerSlots.set(user.userId, { zone, pos: slot });
      player = new Player(user, this.skins, slot);
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

  private evictOldest() {
    let oldest: Player | null = null;
    for (const p of this.players.values()) {
      if (!oldest || p.lastActive < oldest.lastActive) oldest = p;
    }
    if (oldest) {
      this.scene.remove(oldest.group);
      oldest.dispose();
      this.releaseSlot(oldest.user.userId);
      this.players.delete(oldest.user.userId);
    }
  }

  handleChat(event: ChatEvent) {
    const player = this.ensurePlayer(event.user);
    const r = this.rules;
    const isStart =
      normalizeComment(event.comment) === normalizeComment(r.startCommand);

    // Comment (bất kỳ) gia hạn thời gian nhảy nếu đang nhảy
    player.keepDancing(r.danceExtendSec * 1000, r.danceMaxSec * 1000);
    // Lệnh lên sàn (hoặc admin tắt yêu cầu lệnh → ai comment cũng nhảy).
    // stayOnFloor: đã lên sàn là ở lại luôn cho tới khi rời live.
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
    this.hype = Math.min(1, this.hype + 0.015);
  }

  handleGift(event: GiftEvent) {
    const player = this.ensurePlayer(event.user);
    player.celebrate();
    const bursts = Math.min(
      6,
      1 + Math.floor((event.diamondCount * event.repeatCount) / 100),
    );
    this.fireworks.spawn(player.group.position, bursts);
    this.confetti.burst(30 + bursts * 20);
    this.showBanner(
      `🎁 ${event.user.nickname} tặng ${event.giftName} ×${event.repeatCount}` +
        (event.totalDiamonds > 0 ? ` 💎${event.totalDiamonds}` : ""),
    );

    // Hành động theo bảng quà admin tự soạn: mốc cao nhất đạt được sẽ thắng
    const value = event.diamondCount;
    const matched = this.rules.giftActions
      .filter((rule) => value >= rule.min)
      .sort((a, b) => b.min - a.min)[0];
    switch (matched?.action) {
      case "badge":
        player.giveBadge();
        player.grow();
        this.focusOn(player);
        this.fireworks.spawn(player.group.position, 4);
        break;
      case "focus":
        this.focusOn(player);
        this.fireworks.spawn(player.group.position, 2);
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
      default:
        break;
    }

    if (!event.streaking) {
      player.diamonds += event.totalDiamonds;
      this.updatePodium();
    }
    this.hype = Math.min(1, this.hype + 0.18);
  }

  /** Camera lướt tới cận cảnh nhân vật vài giây rồi trở lại. */
  private focusOn(player: Player, ms = 3500) {
    this.focusPlayer = player;
    this.focusUntil = performance.now() + ms;
    // Đảm bảo thấy tên người được zoom (kể cả khi đang ở khán đài)
    player.showLabel(ms + 1200);
  }

  /** Phát nhạc + cập nhật màn hình "now playing" (gọi từ nút bấm trên HUD). */
  async playMusic(url: string, title: string) {
    await this.music.play(url, title);
    this.npScreen.setTitle(title);
  }

  handleLike(event: LikeEvent) {
    this.hype = Math.min(1, this.hype + event.count * 0.014);
    const player = this.players.get(event.user.userId);
    if (player) player.lastActive = performance.now();
  }

  handleActivity(event: ActivityEvent) {
    const player = this.ensurePlayer(event.user);
    if (event.kind === "follow" || event.kind === "share") {
      player.celebrate();
      this.hype = Math.min(1, this.hype + 0.06);
    }
  }

  reset() {
    this.stopDemo();
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
    this.banners.forEach((b) => this.scene.remove(b.sprite));
    this.banners = [];
    this.podium.forEach((slot) => {
      slot.userId = null;
      slot.label.material.opacity = 0;
    });
  }

  // --- Banner quà tặng -------------------------------------------------------------

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

  // --- Podium ---------------------------------------------------------------------

  private updatePodium() {
    const top = [...this.players.values()]
      .filter((p) => p.diamonds > 0)
      .sort((a, b) => b.diamonds - a.diamonds)
      .slice(0, 3);
    const topIds = new Set(top.map((p) => p.user.userId));

    // Rớt khỏi top → rời bục, quay về sàn (nếu đang nhảy) hoặc khán đài
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
    // Đổi hạng (1↔2...) → nhả slot cũ trước khi gán lại
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
        // VIP trên bục quẩy không nghỉ đến khi rớt hạng
        player.startDancing(Number.POSITIVE_INFINITY);
        player.setHome(slot.pos);
      }
      // Label luôn cập nhật theo số kim cương mới
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

  // --- Chế độ demo: giả lập đám đông để xem độ sôi động --------------------------------

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
      start, start, start, // chat lệnh lên sàn
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

    // Người vào phòng dồn dập lúc đầu, vào xong chat "1" để quẩy luôn
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

  /**
   * Trang /test: spawn mỗi skin × mỗi điệu nhảy, nhãn ghi tên điệu —
   * không cần kết nối gì để soi nhân vật + động tác.
   */
  startShowcase() {
    this.reset();
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

  // --- Loop -------------------------------------------------------------------------

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = performance.now() / 1000;

    // Nhịp: có nhạc thật thì bắt beat từ nhạc (Web Audio), không thì auto BPM
    this.music.sensitivity = this.rules.beatSensitivity;
    this.music.update();
    let beat: Beat;
    if (this.music.playing) {
      beat = this.music.getBeat();
    } else {
      this.beatT += (dt * (this.rules.autoBpm * (1 + this.hype * 0.12))) / 60;
      if (this.beatT >= 1) {
        this.beatT -= 1;
        this.beatIndex++;
      }
      beat = { index: this.beatIndex, pulse: this.beatT };
    }

    this.hype = Math.max(0, this.hype - HYPE_DECAY_PER_S * dt);
    // Nhạc căng cũng đẩy không khí lên như tim/quà
    const effHype = Math.max(this.hype, this.music.level * 0.75);

    this.players.forEach((p) => {
      // Luân chuyển sàn/khán đài theo zoneMode (VIP trên bục DJ không đụng)
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
      p.update(dt, effHype, beat, this.music.playing);
    });
    // Năng lượng bass realtime của nhạc — đèn "thở" theo tiếng nhạc
    const level = this.music.playing ? this.music.level : 0;
    this.floor.update(dt, effHype, beat);
    this.ledWall.update(dt, effHype, beat, level);
    this.beams.update(dt, effHype, beat, level);
    this.ball.update(dt, effHype);
    this.clubLights.update(dt, effHype, beat, level);
    this.speakers[0].update(dt, effHype, beat);
    this.speakers[1].update(dt, effHype, beat);
    this.fireworks.update(dt);
    this.confetti.update(dt, effHype);
    this.updateBanners(dt);

    // Khu DJ quẩy theo beat để cả sàn bắt nhịp
    const kick = Math.max(0, 1 - beat.pulse * 3);
    this.djSprite.position.y = this.djBaseY + kick * 0.28;
    this.djSprite.material.rotation = Math.sin(t * 2.4) * 0.1;
    this.decks.forEach((d) => (d.rotation.y += dt * (2 + effHype * 6)));
    (this.strobe.material as THREE.MeshBasicMaterial).opacity =
      kick * (0.06 + level * 0.45 + effHype * 0.18);
    this.npScreen.paused = !this.music.playing;
    this.npScreen.update(dt, this.music.getSpectrum(), beat);

    // Camera: lắc nhẹ như quay tay; khi có donate lớn thì lướt vào cận cảnh
    const focusing =
      this.focusPlayer !== null && performance.now() < this.focusUntil;
    this.focusBlend +=
      ((focusing ? 1 : 0) - this.focusBlend) * Math.min(1, dt * 2.5);
    if (!focusing && this.focusBlend < 0.01) this.focusPlayer = null;

    // Camera: sway (đứng lắc nhẹ) / orbit (lắc cung ±50° phía TRƯỚC sân khấu,
    // không vòng ra sau lưng LED). Trọng tâm luôn là trục sân khấu–sàn nhảy.
    let baseX: number;
    let baseZ: number;
    const lookY = 1.8;
    const lookZ = -2.5;
    const baseY =
      7.2 + Math.sin(t * 0.09) * 0.3 + Math.sin(t * 5) * effHype * 0.04;
    if (this.rules.cameraMode === "orbit") {
      this.orbitAngle += dt * (0.18 + effHype * 0.06);
      const arc = Math.sin(this.orbitAngle) * 0.85; // ±~49°
      baseX = Math.sin(arc) * 19.5;
      baseZ = Math.cos(arc) * 19.5;
    } else {
      baseX = Math.sin(t * 0.14) * (2.2 + effHype * 0.8);
      baseZ = 21 - Math.sin(t * 0.055) * 1.6; // thở tiến-lùi chậm
    }
    if (this.focusPlayer && this.focusBlend > 0.01) {
      const target = this.focusPlayer.group.position;
      const b = this.focusBlend;
      // Bám theo độ cao THẬT của nhân vật — VIP đứng trên bục DJ cao ~3m
      // vẫn lọt trọn khung hình, không bị cắt mất đầu
      const focusCamY = target.y + 2.6;
      const focusLookY = target.y + 1.2;
      this.camera.position.set(
        baseX * (1 - b) + target.x * 0.7 * b,
        baseY * (1 - b) + focusCamY * b,
        baseZ * (1 - b) + (target.z + 6) * b,
      );
      this.lookTarget.set(
        target.x * b,
        lookY * (1 - b) + focusLookY * b,
        lookZ * (1 - b) + target.z * b,
      );
      this.camera.lookAt(this.lookTarget);
    } else {
      this.camera.position.set(baseX, baseY, baseZ);
      this.camera.lookAt(0, lookY, lookZ);
    }

    this.bloom.strength = 0.4 + effHype * 0.4;
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


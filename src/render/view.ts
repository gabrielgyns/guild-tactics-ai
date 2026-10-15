import * as THREE from 'three';
import { posKey, samePos, terrainAt } from '../domain/board';
import { findAbility, getHero } from '../domain/heroes';
import type { BattleEvent, BattleState, Board, DamageTag, Element, Pos, StatusKind, Unit } from '../domain/types';
import { buildHeroModel, mat, type HeroModel, type SkinId } from './models';
import { ELEMENT_COLOR } from '../domain/elements';

export type HighlightKind = 'move' | 'moveDanger' | 'attack' | 'range' | 'area' | 'heal' | 'deploy' | 'select' | 'path' | 'threat';

const HL: Record<HighlightKind, { color: number; opacity: number }> = {
  move: { color: 0x58b4ff, opacity: 0.55 },
  moveDanger: { color: 0xc58bff, opacity: 0.6 },
  threat: { color: 0xff3b30, opacity: 0.45 },
  path: { color: 0xbfe3ff, opacity: 0.85 },
  attack: { color: 0xff5a4e, opacity: 0.7 },
  range: { color: 0xff7a6e, opacity: 0.28 },
  area: { color: 0xffb347, opacity: 0.8 },
  heal: { color: 0x7fe0a6, opacity: 0.7 },
  deploy: { color: 0x58b4ff, opacity: 0.45 },
  select: { color: 0xffd166, opacity: 0.95 },
};

const TERRAIN_HEIGHT = { plain: 0, forest: 0, hill: 0.36, rock: 0, water: -0.22, shrine: 0.06 } as const;
const GRASS = {
  plain: [0x74ad52, 0x7db85b, 0x6aa24a, 0x82bb60],
  forest: [0x3f7a3a, 0x4a8743, 0x386f34, 0x447f3e],
  hill: [0x9cb86a, 0xa9c477, 0x93ad62, 0xb0c97e],
  rock: [0x7f8c6c, 0x86937a, 0x768462, 0x8a9878],
  water: [0x3b8fd6, 0x3b8fd6, 0x3b8fd6, 0x3b8fd6],
  shrine: [0xc9c1a6, 0xd4cdb4, 0xbdb497, 0xcfc7ab],
};

export const STATUS_LABEL: Record<StatusKind, string> = {
  stun: 'Atordoado',
  root: 'Preso',
  burn: 'A arder',
  mark: 'Marcado',
  weak: 'Enfraquecido',
  empower: 'Fortalecido',
  guard: 'Em guarda',
};

export const TAG_LABEL: Record<DamageTag, string> = {
  cover: 'Cobertura',
  height: 'Altura',
  flank: 'Cerco',
  mark: 'Marca',
  guard: 'Guarda',
  weak: 'Fraco',
  execute: 'Execução',
  collision: 'Colisão',
  burn: 'Queimadura',
  advantage: 'Vantagem',
  resisted: 'Resistido',
  bond: 'Vínculo',
  bondGuard: 'Proteção',
};

interface Tween {
  start: number;
  dur: number;
  fn: (t: number) => void;
  resolve: () => void;
}

interface UnitView {
  id: string;
  model: HeroModel;
  tag: HTMLDivElement;
  hpFill: HTMLDivElement;
  hpGhost: HTMLDivElement;
  shieldFill: HTMLDivElement;
  energyFill: HTMLDivElement;
  icons: HTMLDivElement;
  hp: number;
  shield: number;
  maxHp: number;
  pos: Pos;
  alive: boolean;
}

function overlayTexture(strong: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = `rgba(255,255,255,${strong ? 0.35 : 0.42})`;
  g.fillRect(4, 4, 56, 56);
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = strong ? 6 : 4;
  g.strokeRect(5, 5, 54, 54);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  return t;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export class BattleView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private boardGroup = new THREE.Group();
  private fxGroup = new THREE.Group();
  private board: Board | null = null;
  private hitBoxes: THREE.Mesh[] = [];
  private overlays: THREE.Mesh[][] = [];
  private cursor: THREE.Mesh;
  private marker: THREE.Group;
  private water: THREE.Mesh[] = [];
  private flames: THREE.Mesh[] = [];
  private flies: THREE.Mesh[] = [];
  private units = new Map<string, UnitView>();
  private tweens: Tween[] = [];
  private azimuth = Math.PI / 4;
  private zoom = 1;
  private targetZoom = 1;
  private focus = new THREE.Vector3();
  private shake = 0;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hoverPos: Pos | null = null;
  private activeId: string | null = null;
  private clock = new THREE.Clock();
  private overlayTexSoft = overlayTexture(false);
  private overlayTexStrong = overlayTexture(true);
  speed = 1;
  /** Cosmetic skin per hero (player side only); set by the game from the mastery profile. */
  skinOf: (heroId: string, side: Unit['side']) => SkinId = () => 'classic';

  onHover: (p: Pos | null) => void = () => {};
  onClick: (p: Pos, pointerType: string) => void = () => {};
  onRightClick: () => void = () => {};

  constructor(private host: HTMLElement, private tagLayer: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    this.scene.add(this.boardGroup, this.fxGroup);

    const hemi = new THREE.HemisphereLight(0xfff1d6, 0x3a4660, 1.7);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
    sun.position.set(-4, 9, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -8;
    sc.right = sc.top = 8;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);

    this.cursor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.overlayTexStrong, transparent: true, depthWrite: false, color: 0xffffff }),
    );
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.renderOrder = 3;
    this.cursor.visible = false;
    this.scene.add(this.cursor);

    this.marker = new THREE.Group();
    const gold = mat(0xffd166, 0xb07a10);
    for (const [w, y] of [
      [0.22, 0.16],
      [0.14, 0.08],
      [0.06, 0],
    ] as const) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, w), gold);
      m.position.y = y;
      this.marker.add(m);
    }
    this.marker.visible = false;
    this.scene.add(this.marker);

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this.handlePointer(e, false));
    el.addEventListener('pointerup', (e) => {
      if (e.button === 2) return;
      this.handlePointer(e, true);
    });
    el.addEventListener('pointerleave', () => this.setHoverInternal(null));
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false },
    );
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onRightClick();
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------ board

  loadBoard(board: Board) {
    this.board = board;
    this.boardGroup.clear();
    this.hitBoxes = [];
    this.water = [];
    this.shrineCrystals = [];
    this.flames = [];
    this.flies = [];
    this.overlays = [];
    for (const u of this.units.values()) this.removeUnitView(u);
    this.units.clear();

    const { width: W, height: H } = board;
    // Stone plinth under the board: the war table.
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 0.7, 0.5, H + 0.7), mat(0x4a4f5c));
    plinth.position.y = -0.75;
    plinth.receiveShadow = true;
    this.boardGroup.add(plinth);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(W + 0.9, 0.16, H + 0.9), mat(0x6b5232));
    trim.position.y = -1.04;
    this.boardGroup.add(trim);
    // Corner torches on the war table.
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const x = sx * (W / 2 + 0.2);
      const z = sz * (H / 2 + 0.2);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.14), mat(0x5b4636));
      post.position.set(x, -0.15, z);
      const bowl = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.26), mat(0x3a3a40));
      bowl.position.set(x, 0.24, z);
      const flame = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.16), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
      flame.position.set(x, 0.38, z);
      const core = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.08), new THREE.MeshBasicMaterial({ color: 0xfff1b0 }));
      core.position.set(x, 0.36, z);
      const light = new THREE.PointLight(0xffa040, 1.4, 3.2, 1.6);
      light.position.set(x, 0.6, z);
      flame.userData.phase = sx * 1.7 + sz * 0.9;
      this.flames.push(flame);
      this.boardGroup.add(post, bowl, flame, core, light);
    }
    // Fireflies drifting over the board.
    const flyMat = new THREE.MeshBasicMaterial({ color: 0xe8ffa0, transparent: true, opacity: 0.8 });
    for (let i = 0; i < 22; i++) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.035), flyMat);
      f.userData = { ax: (Math.random() - 0.5) * W, az: (Math.random() - 0.5) * H, ph: Math.random() * 10, sp: 0.2 + Math.random() * 0.3 };
      this.flies.push(f);
      this.boardGroup.add(f);
    }

    const capGeo = new THREE.BoxGeometry(1 / 3, 0.1, 1 / 3);
    const caps = new THREE.InstancedMesh(capGeo, new THREE.MeshLambertMaterial(), W * H * 9);
    caps.receiveShadow = true;
    caps.castShadow = true;
    const baseGeo = new THREE.BoxGeometry(1, 1, 1);
    const bases = new THREE.InstancedMesh(baseGeo, new THREE.MeshLambertMaterial(), W * H);
    bases.receiveShadow = true;
    const stones = new THREE.InstancedMesh(baseGeo, new THREE.MeshLambertMaterial(), W * H);
    const decorCap = W * H * 5;
    const decor = new THREE.InstancedMesh(baseGeo, new THREE.MeshLambertMaterial(), decorCap);
    decor.castShadow = true;
    let di = 0;
    const m4 = new THREE.Matrix4();
    const color = new THREE.Color();
    let ci = 0;
    let rand = 1337;
    const rnd = () => {
      rand = (rand * 16807) % 2147483647;
      return rand / 2147483647;
    };

    for (let y = 0; y < H; y++) {
      this.overlays.push([]);
      for (let x = 0; x < W; x++) {
        const t = board.tiles[y][x];
        const top = TERRAIN_HEIGHT[t];
        const c = this.tileCenter({ x, y });
        // Base column (from the plinth up to just under the cap).
        // Strata: stone at the bottom, a band of soil under the grass.
        const baseTop = t === 'water' ? -0.4 : top - 0.1;
        const soilBottom = Math.min(baseTop, -0.24);
        const soilH = baseTop - soilBottom;
        m4.makeScale(0.995, Math.max(0.001, soilH), 0.995).setPosition(c.x, soilBottom + soilH / 2, c.z);
        bases.setMatrixAt(y * W + x, m4);
        bases.setColorAt(y * W + x, color.set(t === 'hill' ? 0x8a6a46 : 0x6e5338).multiplyScalar(0.92 + rnd() * 0.12));
        const stoneH = soilBottom + 0.5;
        m4.makeScale(0.995, stoneH, 0.995).setPosition(c.x, -0.5 + stoneH / 2, c.z);
        stones.setMatrixAt(y * W + x, m4);
        stones.setColorAt(y * W + x, color.set([0x77746c, 0x6b6962, 0x827f76][Math.floor(rnd() * 3)]));

        // Grass tufts, flowers and pebbles near the tile edges (the centre stays clear for units).
        if (t === 'plain' || t === 'hill' || t === 'forest') {
          const n = 2 + Math.floor(rnd() * 3);
          for (let k = 0; k < n && di < decorCap; k++) {
            const edge = rnd() < 0.5;
            const dx = edge ? (rnd() < 0.5 ? -1 : 1) * (0.36 + rnd() * 0.1) : (rnd() - 0.5) * 0.9;
            const dz = edge ? (rnd() - 0.5) * 0.9 : (rnd() < 0.5 ? -1 : 1) * (0.36 + rnd() * 0.1);
            const roll = rnd();
            if (roll < 0.62) {
              m4.makeScale(0.035, 0.07 + rnd() * 0.06, 0.035).setPosition(c.x + dx, top + 0.04, c.z + dz);
              decor.setColorAt(di, color.set(t === 'forest' ? 0x2f6b34 : t === 'hill' ? 0x8fae5a : 0x5e9a40));
            } else if (roll < 0.86 && t !== 'forest') {
              m4.makeScale(0.05, 0.05, 0.05).setPosition(c.x + dx, top + 0.035, c.z + dz);
              decor.setColorAt(di, color.set([0xfff3c4, 0xffd166, 0xf28fb5, 0x9fc8ff][Math.floor(rnd() * 4)]));
            } else {
              m4.makeScale(0.07, 0.04, 0.06).setPosition(c.x + dx, top + 0.02, c.z + dz);
              decor.setColorAt(di, color.set(0xa7a294));
            }
            decor.setMatrixAt(di++, m4);
          }
        }

        for (let i = 0; i < 9; i++) {
          const sx = (i % 3) - 1;
          const sz = Math.floor(i / 3) - 1;
          const jitter = t === 'water' ? 0 : rnd() * 0.03;
          if (t === 'water') {
            m4.makeScale(0.0001, 0.0001, 0.0001).setPosition(0, -5, 0);
          } else {
            m4.makeTranslation(c.x + sx / 3, top - 0.05 + jitter, c.z + sz / 3);
          }
          caps.setMatrixAt(ci, m4);
          const palette = GRASS[t];
          color.set(palette[Math.floor(rnd() * palette.length)]);
          if ((x + y) % 2 === 0) color.multiplyScalar(0.94);
          caps.setColorAt(ci, color);
          ci++;
        }

        if (t === 'water') {
          const w = new THREE.Mesh(
            new THREE.BoxGeometry(1, 0.2, 1),
            new THREE.MeshLambertMaterial({ color: 0x3b8fd6, transparent: true, opacity: 0.82, emissive: 0x0b2c4a }),
          );
          w.position.set(c.x, top - 0.1, c.z);
          w.userData.phase = x * 0.7 + y * 1.3;
          this.water.push(w);
          this.boardGroup.add(w);
          // Foam where the water meets land.
          for (const [ox, oy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || board.tiles[ny][nx] === 'water') continue;
            const foam = new THREE.Mesh(
              new THREE.BoxGeometry(ox ? 0.07 : 0.96, 0.03, oy ? 0.07 : 0.96),
              new THREE.MeshBasicMaterial({ color: 0xe6f6ff, transparent: true, opacity: 0.75 }),
            );
            foam.position.set(c.x + ox * 0.46, top - 0.1, c.z + oy * 0.46);
            foam.userData.phase = w.userData.phase;
            this.water.push(foam);
            this.boardGroup.add(foam);
          }
        }
        if (t === 'forest') this.addTrees(c, rnd);
        if (t === 'rock') this.addRocks(c, rnd);
        if (t === 'shrine') this.addShrine(c);
        if (t === 'hill') {
          const stone = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.16), mat(0xa7a294));
          stone.position.set(c.x + 0.36, top + 0.05, c.z - 0.36);
          stone.castShadow = true;
          this.boardGroup.add(stone);
        }

        // Invisible hit box for picking (material hidden, mesh still raycastable).
        const hit = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.set(c.x, top - 0.5, c.z);
        hit.userData.pos = { x, y };
        this.hitBoxes.push(hit);
        this.boardGroup.add(hit);

        const ov = new THREE.Mesh(
          new THREE.PlaneGeometry(0.98, 0.98),
          new THREE.MeshBasicMaterial({ map: this.overlayTexSoft, transparent: true, depthWrite: false }),
        );
        ov.rotation.x = -Math.PI / 2;
        ov.position.set(c.x, top + 0.012, c.z);
        ov.renderOrder = 2;
        ov.visible = false;
        this.overlays[y].push(ov);
        this.boardGroup.add(ov);
      }
    }
    caps.instanceMatrix.needsUpdate = true;
    if (caps.instanceColor) caps.instanceColor.needsUpdate = true;
    decor.count = di;
    for (const im of [bases, stones, decor]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    this.boardGroup.add(caps, bases, stones, decor);
    this.resize();
  }

  private addTrees(c: THREE.Vector3, rnd: () => number) {
    const spots = [
      [0.3, -0.3],
      [-0.32, 0.28],
    ];
    for (const [dx, dz] of spots) {
      const s = 0.8 + rnd() * 0.3;
      if (rnd() < 0.5) {
        // Pine: a trunk and three shrinking tiers.
        const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18 * s, 0.08), mat(0x5b3d22));
        trunk.position.set(c.x + dx, 0.09 * s, c.z + dz);
        trunk.castShadow = true;
        this.boardGroup.add(trunk);
        [0.34, 0.26, 0.16].forEach((w, i) => {
          const tier = new THREE.Mesh(new THREE.BoxGeometry(w * s, 0.16 * s, w * s), mat(i % 2 ? 0x2f6b3a : 0x26583a));
          tier.position.set(c.x + dx, (0.22 + i * 0.15) * s, c.z + dz);
          tier.rotation.y = i * 0.4;
          tier.castShadow = true;
          this.boardGroup.add(tier);
        });
        continue;
      }
      const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22 * s, 0.09), mat(0x6b4a2b));
      trunk.position.set(c.x + dx, 0.11 * s, c.z + dz);
      const leaf1 = new THREE.Mesh(new THREE.BoxGeometry(0.3 * s, 0.24 * s, 0.3 * s), mat(0x2f6b34));
      leaf1.position.set(c.x + dx, 0.32 * s, c.z + dz);
      const leaf2 = new THREE.Mesh(new THREE.BoxGeometry(0.18 * s, 0.16 * s, 0.18 * s), mat(0x3d8442));
      leaf2.position.set(c.x + dx, 0.5 * s, c.z + dz);
      for (const m of [trunk, leaf1, leaf2]) {
        m.castShadow = true;
        this.boardGroup.add(m);
      }
    }
  }

  private shrineCrystals: THREE.Mesh[] = [];

  private addShrine(c: THREE.Vector3) {
    const top = TERRAIN_HEIGHT.shrine;
    for (const [dx, dz] of [
      [-0.38, -0.38],
      [0.38, 0.38],
    ]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12), mat(0xe8e2cc));
      pillar.position.set(c.x + dx, top + 0.17, c.z + dz);
      pillar.castShadow = true;
      this.boardGroup.add(pillar);
      const crystal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.1), mat(0xc9a0ff, 0x7a4adf));
      crystal.position.set(c.x + dx, top + 0.44, c.z + dz);
      crystal.userData.phase = dx * 3;
      this.shrineCrystals.push(crystal);
      this.boardGroup.add(crystal);
    }
    const rune = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.012, 0.5), mat(0xd9c7ff, 0x5a32a8));
    rune.position.set(c.x, top + 0.006, c.z);
    this.boardGroup.add(rune);
  }

  private addRocks(c: THREE.Vector3, rnd: () => number) {
    const parts: [number, number, number, number, number][] = [
      [0.62, 0.42, 0.58, 0, 0],
      [0.38, 0.3, 0.4, 0.08, 0.42],
      [0.3, 0.24, 0.28, -0.22, 0.18],
    ];
    const greys = [0x8d8f96, 0x7a7c84, 0x9a9ca3];
    parts.forEach(([w, h, d, dx, y], i) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(greys[i]));
      m.position.set(c.x + dx, y + h / 2, c.z + (rnd() - 0.5) * 0.12);
      m.rotation.y = (rnd() - 0.5) * 0.4;
      m.castShadow = true;
      m.receiveShadow = true;
      this.boardGroup.add(m);
      if (i === 0) {
        // Moss on top of the main boulder.
        const moss = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.04, d * 0.6), mat(0x5e8a3e));
        moss.position.set(m.position.x - 0.05, y + h + 0.02, m.position.z + 0.04);
        moss.rotation.y = m.rotation.y;
        this.boardGroup.add(moss);
      }
    });
  }

  tileTop(p: Pos): number {
    if (!this.board) return 0;
    const t = terrainAt(this.board, p);
    return t === 'water' ? -0.2 : TERRAIN_HEIGHT[t];
  }

  tileCenter(p: Pos): THREE.Vector3 {
    const W = this.board?.width ?? 6;
    const H = this.board?.height ?? 6;
    return new THREE.Vector3(p.x - (W - 1) / 2, 0, p.y - (H - 1) / 2);
  }

  private standPoint(p: Pos): THREE.Vector3 {
    const v = this.tileCenter(p);
    v.y = this.tileTop(p);
    return v;
  }

  // ------------------------------------------------------------ highlights & cursor

  setHighlights(layers: Map<string, HighlightKind>) {
    if (!this.board) return;
    for (let y = 0; y < this.board.height; y++)
      for (let x = 0; x < this.board.width; x++) {
        const ov = this.overlays[y][x];
        const kind = layers.get(posKey({ x, y }));
        ov.visible = !!kind;
        if (kind) {
          const m = ov.material as THREE.MeshBasicMaterial;
          m.color.setHex(HL[kind].color);
          m.opacity = HL[kind].opacity;
          m.map = kind === 'attack' || kind === 'select' || kind === 'area' ? this.overlayTexStrong : this.overlayTexSoft;
        }
      }
  }

  setCursor(p: Pos | null, color = 0xffffff) {
    this.cursor.visible = !!p;
    if (p) {
      const c = this.standPoint(p);
      this.cursor.position.set(c.x, c.y + 0.02, c.z);
      (this.cursor.material as THREE.MeshBasicMaterial).color.setHex(color);
    }
  }

  setActive(unitId: string | null) {
    this.activeId = unitId;
    this.marker.visible = !!unitId && this.units.has(unitId);
  }

  // ------------------------------------------------------------ units

  syncUnits(state: BattleState) {
    for (const u of state.units) {
      let view = this.units.get(u.id);
      if (!view && u.alive) view = this.createUnitView(u);
      if (!view) continue;
      if (!u.alive) {
        if (view.alive) this.removeUnitView(view);
        view.alive = false;
        continue;
      }
      view.hp = u.hp;
      view.shield = u.shield;
      view.energyFill.style.width = `${u.energy}%`;
      view.tag.classList.toggle('ult-ready', u.energy >= 100);
      view.pos = { ...u.pos };
      const sp = this.standPoint(u.pos);
      view.model.root.position.copy(sp);
      this.renderTag(view);
      this.renderIcons(view, u);
    }
  }

  private createUnitView(u: Unit): UnitView {
    const model = buildHeroModel(u.heroId, u.side, this.skinOf(u.heroId, u.side));
    model.root.userData.unitId = u.id;
    model.root.rotation.y = u.side === 'player' ? Math.PI : 0;
    this.scene.add(model.root);
    const tag = document.createElement('div');
    tag.className = `unit-tag side-${u.side}`;
    tag.innerHTML = `<div class="tag-icons"></div><div class="hprow"><span class="el-dot" style="background:${ELEMENT_COLOR[u.element]}"></span><div class="hpbar"><div class="hp-ghost"></div><div class="hp-fill"></div><div class="hp-shield"></div></div></div><div class="enbar"><div></div></div>`;
    this.tagLayer.appendChild(tag);
    const view: UnitView = {
      id: u.id,
      model,
      tag,
      hpFill: tag.querySelector('.hp-fill')!,
      hpGhost: tag.querySelector('.hp-ghost')!,
      shieldFill: tag.querySelector('.hp-shield')!,
      energyFill: tag.querySelector('.enbar > div')!,
      icons: tag.querySelector('.tag-icons')!,
      hp: u.hp,
      shield: u.shield,
      maxHp: u.stats.maxHp,
      pos: { ...u.pos },
      alive: true,
    };
    this.units.set(u.id, view);
    return view;
  }

  private removeUnitView(v: UnitView) {
    this.scene.remove(v.model.root);
    v.tag.remove();
  }

  private renderTag(v: UnitView, previewDamage = 0, previewHeal = 0) {
    const pct = (n: number) => `${Math.max(0, Math.min(100, (n / v.maxHp) * 100))}%`;
    const absorbed = Math.min(v.shield, previewDamage);
    const hpAfter = Math.min(v.maxHp, Math.max(0, v.hp - (previewDamage - absorbed) + previewHeal));
    v.hpFill.style.width = pct(Math.min(v.hp, hpAfter));
    v.hpGhost.style.width = pct(Math.max(v.hp, hpAfter));
    v.hpGhost.classList.toggle('heal', previewHeal > 0);
    v.shieldFill.style.width = pct(Math.max(0, v.shield - absorbed));
    v.tag.classList.toggle('low', v.hp <= v.maxHp * 0.3);
  }

  private renderIcons(v: UnitView, u: Unit) {
    v.icons.innerHTML = u.statuses
      .map((st) => `<span class="st st-${st.kind}" title="${STATUS_LABEL[st.kind]}">${STATUS_GLYPH[st.kind]}</span>`)
      .join('');
  }

  /** Ghost bars showing the outcome of the action under the cursor. */
  showPreview(entries: { unitId: string; damage: number; heal: number; lethal: boolean }[]) {
    const byId = new Map(entries.map((e) => [e.unitId, e]));
    for (const v of this.units.values()) {
      if (!v.alive) continue;
      const e = byId.get(v.id);
      this.renderTag(v, e?.damage ?? 0, e?.heal ?? 0);
      v.tag.classList.toggle('targeted', !!e);
      v.tag.classList.toggle('lethal', !!e?.lethal);
      let badge = v.tag.querySelector<HTMLDivElement>('.preview-badge');
      if (e && (e.damage || e.heal)) {
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'preview-badge';
          v.tag.prepend(badge);
        }
        badge.textContent = e.damage ? `−${e.damage}${e.lethal ? ' ☠' : ''}` : `+${e.heal}`;
        badge.classList.toggle('heal', !e.damage);
      } else badge?.remove();
    }
  }

  unitPosOnScreen(unitId: string): { x: number; y: number } | null {
    const v = this.units.get(unitId);
    if (!v) return null;
    return this.project(v.model.root.position.clone().add(new THREE.Vector3(0, 0.9, 0)));
  }

  // ------------------------------------------------------------ camera & loop

  /** Zoom in/out; when zoomed in the camera follows the active unit. */
  zoomBy(factor: number) {
    this.targetZoom = Math.max(0.8, Math.min(2.2, this.targetZoom * factor));
  }

  rotate(dir: 1 | -1) {
    const from = this.azimuth;
    const to = from + (dir * Math.PI) / 2;
    return this.tween(380, (t) => {
      this.azimuth = from + (to - from) * easeInOut(t);
    }, true);
  }

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    const aspect = w / h;
    // Fit the board: scale with its size (6×6 was the original framing).
    const size = Math.max(this.board?.width ?? 6, this.board?.height ?? 6) / 6;
    const halfH = Math.max(4.1, 5.0 / aspect) * size;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  private frame() {
    const now = performance.now();
    const time = this.clock.getElapsedTime();
    this.tweens = this.tweens.filter((tw) => {
      const t = Math.min(1, (now - tw.start) / tw.dur);
      tw.fn(t);
      if (t >= 1) {
        tw.resolve();
        return false;
      }
      return true;
    });

    const R = 20;
    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    this.shake *= 0.86;
    if (this.shake < 0.003) this.shake = 0;
    if (Math.abs(this.zoom - this.targetZoom) > 0.001) {
      this.zoom += (this.targetZoom - this.zoom) * 0.2;
      this.camera.zoom = this.zoom;
      this.camera.updateProjectionMatrix();
    }
    const want = new THREE.Vector3();
    const followed = this.activeId ? this.units.get(this.activeId) : undefined;
    if (this.zoom > 1.05 && followed?.alive) {
      // Follow strength grows with zoom so the board edge never jumps.
      want.copy(followed.model.root.position).setY(0).multiplyScalar(Math.min(1, (this.zoom - 1) * 1.4));
    }
    this.focus.lerp(want, 0.08);
    const f = this.focus;
    this.camera.position.set(f.x + Math.sin(this.azimuth) * R + sx, R * 0.92 + sy, f.z + Math.cos(this.azimuth) * R);
    this.camera.lookAt(f.x + sx, -0.4 + sy, f.z);

    for (const c of this.shrineCrystals) {
      c.rotation.y = time * 1.2 + c.userData.phase;
      c.position.y = 0.5 + Math.sin(time * 2 + c.userData.phase) * 0.04;
    }
    for (const f of this.flames) {
      const k = 1 + Math.sin(time * 11 + f.userData.phase) * 0.12 + Math.sin(time * 23 + f.userData.phase) * 0.06;
      f.scale.set(k, 1 + (k - 1) * 2, k);
    }
    for (const f of this.flies) {
      const d = f.userData as { ax: number; az: number; ph: number; sp: number };
      f.position.set(d.ax + Math.sin(time * d.sp + d.ph) * 0.8, 0.6 + Math.sin(time * d.sp * 1.7 + d.ph) * 0.35, d.az + Math.cos(time * d.sp * 0.8 + d.ph) * 0.8);
      (f.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.max(0, Math.sin(time * 2.4 + d.ph)) * 0.6;
    }
    // Idle breathing: each hero on its own phase.
    for (const v of this.units.values()) {
      if (!v.alive) continue;
      const ph = v.id.length * 1.37 + v.id.charCodeAt(1);
      v.model.idle.position.y = Math.sin(time * 2.2 + ph) * 0.012;
      v.model.idle.scale.y = 1 + Math.sin(time * 2.2 + ph) * 0.012;
    }
    for (const w of this.water) w.position.y = -0.32 + Math.sin(time * 1.6 + w.userData.phase) * 0.02;
    (this.cursor.material as THREE.MeshBasicMaterial).opacity = 0.75 + Math.sin(time * 6) * 0.2;

    if (this.activeId) {
      const v = this.units.get(this.activeId);
      if (v && v.alive) {
        this.marker.visible = true;
        this.marker.position.copy(v.model.root.position).add(new THREE.Vector3(0, 1.22 + Math.sin(time * 4) * 0.06, 0));
        this.marker.rotation.y = time * 1.5;
        v.model.ring.scale.setScalar(1 + Math.sin(time * 5) * 0.04);
      } else this.marker.visible = false;
    }

    const half = new THREE.Vector3(0, 1.0, 0);
    for (const v of this.units.values()) {
      if (!v.alive) continue;
      const s = this.project(v.model.root.position.clone().add(half));
      v.tag.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private project(v: THREE.Vector3) {
    const p = v.clone().project(this.camera);
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
  }

  private handlePointer(e: PointerEvent, click: boolean) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const unitMeshes: THREE.Object3D[] = [];
    for (const v of this.units.values()) if (v.alive) unitMeshes.push(v.model.root);
    const hits = this.raycaster.intersectObjects([...unitMeshes, ...this.hitBoxes], true);
    let pos: Pos | null = null;
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.unitId && !o.userData.pos) o = o.parent;
      if (!o) continue;
      if (o.userData.unitId) {
        const v = this.units.get(o.userData.unitId);
        if (v) pos = { ...v.pos };
      } else pos = o.userData.pos;
      if (pos) break;
    }
    if (click) {
      if (pos) this.onClick(pos, e.pointerType);
    } else this.setHoverInternal(pos);
  }

  private setHoverInternal(p: Pos | null) {
    if ((p && this.hoverPos && samePos(p, this.hoverPos)) || (!p && !this.hoverPos)) return;
    this.hoverPos = p;
    this.onHover(p);
  }

  // ------------------------------------------------------------ animation primitives

  tween(ms: number, fn: (t: number) => void, ignoreSpeed = false): Promise<void> {
    const dur = ignoreSpeed ? ms : ms / this.speed;
    return new Promise((resolve) => this.tweens.push({ start: performance.now(), dur: Math.max(1, dur), fn, resolve }));
  }

  wait(ms: number) {
    return this.tween(ms, () => {});
  }

  private face(v: UnitView, target: Pos) {
    const from = this.tileCenter(v.pos);
    const to = this.tileCenter(target);
    if (from.distanceTo(to) < 0.01) return;
    v.model.root.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
  }

  floater(at: THREE.Vector3 | string, text: string, cls: string, delay = 0) {
    const anchor = typeof at === 'string' ? this.units.get(at)?.model.root.position.clone().add(new THREE.Vector3(0, 1.0, 0)) : at;
    if (!anchor) return;
    const s = this.project(anchor);
    const el = document.createElement('div');
    el.className = `floater ${cls}`;
    el.textContent = text;
    el.style.left = `${s.x}px`;
    el.style.top = `${s.y}px`;
    el.style.animationDelay = `${delay}ms`;
    el.style.animationDuration = `${1300 / Math.min(this.speed, 1.6)}ms`;
    this.tagLayer.appendChild(el);
    setTimeout(() => el.remove(), 1500 / Math.min(this.speed, 1.6) + delay);
  }

  private burst(at: THREE.Vector3, color: number, count = 10, up = false) {
    const geo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
    const parts: { m: THREE.Mesh; v: THREE.Vector3 }[] = [];
    const material = new THREE.MeshBasicMaterial({ color, transparent: true });
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, material);
      m.position.copy(at);
      const v = up
        ? new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 0.8, (Math.random() - 0.5) * 0.6)
        : new THREE.Vector3((Math.random() - 0.5) * 2.2, Math.random() * 1.8, (Math.random() - 0.5) * 2.2);
      parts.push({ m, v });
      this.fxGroup.add(m);
    }
    void this.tween(650, (t) => {
      for (const p of parts) {
        p.m.position.addScaledVector(p.v, 0.016);
        if (!up) p.v.y -= 0.09;
        p.m.rotation.x += 0.2;
      }
      material.opacity = 1 - t;
      if (t >= 1) for (const p of parts) this.fxGroup.remove(p.m);
    });
  }

  private flash(v: UnitView, color: number) {
    const originals = v.model.meshes.map((m) => m.material);
    const flashMat = new THREE.MeshBasicMaterial({ color });
    for (const m of v.model.meshes) m.material = flashMat;
    setTimeout(() => v.model.meshes.forEach((m, i) => (m.material = originals[i])), 110 / Math.min(this.speed, 2));
  }

  // ------------------------------------------------------------ event playback

  async animate(ev: BattleEvent, state: BattleState) {
    switch (ev.type) {
      case 'turnStart':
        this.setActive(ev.unitId);
        return;
      case 'move':
        return this.animateMove(ev.unitId, ev.path);
      case 'undoMove': {
        const v = this.units.get(ev.unitId);
        if (!v) return;
        v.pos = { ...ev.to };
        v.model.root.position.copy(this.standPoint(ev.to));
        return;
      }
      case 'abilityUsed':
        return this.animateAbility(ev, state);
      case 'damage':
        return this.animateDamage(ev.unitId, ev.amount, ev.absorbed, ev.tags);
      case 'heal': {
        const v = this.units.get(ev.unitId);
        if (!v) return;
        v.hp = Math.min(v.maxHp, v.hp + ev.amount);
        this.renderTag(v);
        this.floater(ev.unitId, `+${ev.amount}`, 'heal');
        this.burst(v.model.root.position.clone().add(new THREE.Vector3(0, 0.3, 0)), 0x9df2b8, 10, true);
        return this.wait(260);
      }
      case 'shield': {
        const v = this.units.get(ev.unitId);
        if (!v) return;
        v.shield += ev.amount;
        this.renderTag(v);
        this.floater(ev.unitId, `+${ev.amount} escudo`, 'shield');
        this.burst(v.model.root.position.clone().add(new THREE.Vector3(0, 0.4, 0)), 0xbfe3ff, 8, true);
        return this.wait(200);
      }
      case 'status': {
        const good = ev.status === 'empower' || ev.status === 'guard';
        this.floater(ev.unitId, STATUS_LABEL[ev.status], good ? 'buff' : 'debuff', 120);
        return this.wait(160);
      }
      case 'cleanse':
        this.floater(ev.unitId, 'Purificado', 'buff');
        return this.wait(120);
      case 'shrine': {
        const v = this.units.get(ev.unitId);
        if (!v) return;
        v.hp = Math.min(v.maxHp, v.hp + ev.heal);
        this.renderTag(v);
        this.floater(ev.unitId, `Santuário${ev.heal ? ` +${ev.heal}` : ''}`, 'buff');
        this.burst(v.model.root.position.clone().add(new THREE.Vector3(0, 0.2, 0)), 0xc9a0ff, 10, true);
        return this.wait(260);
      }
      case 'extraTurn':
        this.floater(ev.unitId, 'Turno extra!', 'buff');
        return this.wait(300);
      case 'skipTurn':
        this.floater(ev.unitId, 'Atordoado — perde o turno', 'debuff');
        return this.wait(700);
      case 'reposition':
        return this.animateReposition(ev.unitId, ev.from, ev.to, ev.mode);
      case 'death':
        return this.animateDeath(ev.unitId);
      default:
        return;
    }
  }

  private async animateMove(unitId: string, path: Pos[]) {
    const v = this.units.get(unitId);
    if (!v) return;
    for (const step of path) {
      this.face(v, step);
      const from = v.model.root.position.clone();
      const to = this.standPoint(step);
      await this.tween(150, (t) => {
        v.model.root.position.lerpVectors(from, to, t);
        v.model.root.position.y += Math.sin(t * Math.PI) * 0.18;
      });
      v.pos = { ...step };
    }
  }

  private async animateReposition(unitId: string, from: Pos, to: Pos, mode: 'push' | 'dash' | 'teleport' | 'swap') {
    const v = this.units.get(unitId);
    if (!v) return;
    const a = this.standPoint(from);
    const b = this.standPoint(to);
    if (mode === 'dash') this.face(v, to);
    if (mode === 'teleport' || mode === 'swap') {
      await this.tween(160, (t) => v.model.body.scale.setScalar(1 - t * 0.9));
      v.model.root.position.copy(b);
      v.pos = { ...to };
      this.burst(b.clone().add(new THREE.Vector3(0, 0.3, 0)), mode === 'swap' ? 0xbfe9ff : 0xd9e6a0, 8, true);
      await this.tween(160, (t) => v.model.body.scale.setScalar(0.1 + t * 0.9));
      return;
    }
    const dur = mode === 'dash' ? 200 : 220;
    await this.tween(dur, (t) => {
      v.model.root.position.lerpVectors(a, b, easeOut(t));
      if (mode === 'push') v.model.root.position.y += Math.sin(t * Math.PI) * 0.12;
    });
    v.pos = { ...to };
  }

  // ------------------------------------------------------------ elemental VFX

  private static FX: Record<Element, { core: number; glow: number }> = {
    fire: { core: 0xffd27a, glow: 0xff5a1f },
    water: { core: 0xd8f4ff, glow: 0x3fa0ff },
    nature: { core: 0xd6f7a0, glow: 0x3fa35a },
    light: { core: 0xfffbe0, glow: 0xffc94a },
    shadow: { core: 0xe2c8ff, glow: 0x7a3ad0 },
  };

  /** A flat ring that expands and fades on the ground. */
  private impactRing(at: THREE.Vector3, color: number, size = 1) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.36, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(at.x, at.y + 0.04, at.z);
    this.fxGroup.add(ring);
    void this.tween(420, (t) => {
      ring.scale.setScalar((0.6 + easeOut(t) * 1.4) * size);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      if (t >= 1) this.fxGroup.remove(ring);
    });
  }

  /** Element-flavoured particles: embers, ice shards, leaves, light rays or shadow smoke. */
  private elementBurst(at: THREE.Vector3, el: Element, count = 10) {
    const fx = BattleView.FX[el];
    const parts: { m: THREE.Mesh; v: THREE.Vector3; spin: number }[] = [];
    const material = new THREE.MeshBasicMaterial({ color: fx.glow, transparent: true });
    const coreMat = new THREE.MeshBasicMaterial({ color: fx.core, transparent: true });
    if (el === 'light') {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.34, 2.2, 0.34), new THREE.MeshBasicMaterial({ color: fx.core, transparent: true, opacity: 0.7, depthWrite: false }));
      beam.position.set(at.x, at.y + 1.0, at.z);
      this.fxGroup.add(beam);
      void this.tween(500, (t) => {
        beam.scale.set(1 - t * 0.8, 1, 1 - t * 0.8);
        (beam.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t);
        if (t >= 1) this.fxGroup.remove(beam);
      });
    }
    for (let i = 0; i < count; i++) {
      const geo =
        el === 'water'
          ? new THREE.BoxGeometry(0.04, 0.14, 0.04)
          : el === 'nature'
            ? new THREE.BoxGeometry(0.09, 0.015, 0.06)
            : el === 'shadow'
              ? new THREE.BoxGeometry(0.12, 0.12, 0.12)
              : new THREE.BoxGeometry(0.06, 0.06, 0.06);
      const m = new THREE.Mesh(geo, i % 3 === 0 ? coreMat : material);
      m.position.copy(at);
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const v =
        el === 'fire'
          ? new THREE.Vector3(Math.cos(a) * 0.4, 1.2 + Math.random(), Math.sin(a) * 0.4)
          : el === 'water'
            ? new THREE.Vector3(Math.cos(a) * 2, 1 + Math.random(), Math.sin(a) * 2)
            : el === 'nature'
              ? new THREE.Vector3(Math.cos(a) * 1.2, 0.8 + Math.random() * 0.6, Math.sin(a) * 1.2)
              : el === 'shadow'
                ? new THREE.Vector3(Math.cos(a) * 0.6, 0.3 + Math.random() * 0.3, Math.sin(a) * 0.6)
                : new THREE.Vector3(Math.cos(a) * 0.8, 1.6 + Math.random(), Math.sin(a) * 0.8);
      parts.push({ m, v, spin: (Math.random() - 0.5) * 0.6 });
      this.fxGroup.add(m);
    }
    void this.tween(el === 'shadow' ? 700 : 620, (t) => {
      for (const p of parts) {
        p.m.position.addScaledVector(p.v, 0.016);
        if (el === 'water') p.v.y -= 0.12;
        if (el === 'nature') {
          p.v.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.12);
          p.v.y -= 0.03;
        }
        if (el === 'shadow') p.m.scale.setScalar(1 + t * 2.2);
        p.m.rotation.x += p.spin;
        p.m.rotation.y += p.spin;
      }
      material.opacity = 1 - t;
      coreMat.opacity = 1 - t;
      if (t >= 1) for (const p of parts) this.fxGroup.remove(p.m);
    });
  }

  /** A glowing projectile with a light and a fading trail; arrows fly point-first. */
  private async projectileFx(from: THREE.Vector3, to: THREE.Vector3, el: Element, arc: number, arrow: boolean) {
    const fx = BattleView.FX[el];
    const head = arrow
      ? new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.34), new THREE.MeshBasicMaterial({ color: 0xe8dcc0 }))
      : new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), new THREE.MeshBasicMaterial({ color: fx.core }));
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(arrow ? 0.08 : 0.24, arrow ? 0.08 : 0.24, arrow ? 0.12 : 0.24),
      new THREE.MeshBasicMaterial({ color: fx.glow, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    head.add(glow);
    const light = new THREE.PointLight(fx.glow, arrow ? 0.6 : 2.2, 2.5, 1.5);
    head.add(light);
    this.fxGroup.add(head);
    const trailMat = new THREE.MeshBasicMaterial({ color: fx.glow, transparent: true, opacity: 0.6, depthWrite: false });
    const trail: THREE.Mesh[] = [];
    const prev = from.clone();
    const dist = from.distanceTo(to);
    await this.tween(150 + dist * 65, (t) => {
      head.position.lerpVectors(from, to, t);
      head.position.y += Math.sin(t * Math.PI) * arc;
      if (arrow) head.lookAt(prev.clone().lerp(head.position, 2));
      else head.rotation.set(t * 9, t * 7, 0);
      prev.copy(head.position);
      if (Math.random() < 0.7) {
        const bit = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), trailMat);
        bit.position.copy(head.position);
        trail.push(bit);
        this.fxGroup.add(bit);
      }
      for (const b of trail) b.scale.multiplyScalar(0.9);
    });
    this.fxGroup.remove(head);
    for (const b of trail) this.fxGroup.remove(b);
  }

  /** A blade arc swept in front of the attacker. */
  private slash(at: THREE.Vector3, facing: number, color: number) {
    const arc = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.04, 0.08), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
    arc.position.copy(at);
    this.fxGroup.add(arc);
    void this.tween(220, (t) => {
      arc.rotation.set(0.6, facing + (t - 0.5) * 2.2, 0.4);
      (arc.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      if (t >= 1) this.fxGroup.remove(arc);
    });
  }

  /** Full-screen tint for ultimates. */
  private screenFlash(color: number) {
    const el = document.createElement('div');
    el.className = 'screen-flash';
    el.style.background = `#${color.toString(16).padStart(6, '0')}`;
    this.tagLayer.appendChild(el);
    setTimeout(() => el.remove(), 600);
  }

  private async animateAbility(ev: Extract<BattleEvent, { type: 'abilityUsed' }>, state: BattleState) {
    const caster = state.units.find((u) => u.id === ev.unitId);
    const v = this.units.get(ev.unitId);
    if (!caster || !v) return;
    const ability = findAbility(caster.heroId, ev.abilityId);
    const hero = getHero(caster.heroId);
    const el = hero.element;
    const fx = BattleView.FX[el];
    const selfCast = ability.target === 'self' || samePos(ev.target, v.pos);
    if (!selfCast) this.face(v, ev.target);

    const origin = v.model.root.position.clone().add(new THREE.Vector3(0, 0.55, 0));
    const targetPoint = this.standPoint(ev.target).add(new THREE.Vector3(0, 0.45, 0));
    const ground = (p: Pos) => this.standPoint(p).add(new THREE.Vector3(0, 0.05, 0));

    if (ability.ultimate) {
      this.screenFlash(fx.glow);
      this.shake = 0.14;
      this.impactRing(v.model.root.position, fx.glow, 1.6);
      this.elementBurst(origin, el, 20);
      await this.tween(380, (t) => {
        v.model.body.position.y = Math.sin(t * Math.PI) * 0.4;
        v.model.body.rotation.y = t * Math.PI * 2;
      });
      v.model.body.rotation.y = 0;
    }

    if (selfCast) {
      await this.tween(260, (t) => (v.model.body.position.y = Math.sin(t * Math.PI) * 0.18));
      this.impactRing(v.model.root.position, fx.glow);
      this.elementBurst(origin, el, 10);
      if (ability.area.kind !== 'single') {
        for (const p of ev.area) if (!samePos(p, v.pos)) this.impactRing(ground(p), fx.glow, 0.7);
      }
      return this.wait(140);
    }

    const melee = ability.range.max <= 1 && ability.target === 'enemy' && !ability.effects.some((e) => e.kind === 'dash');
    if (melee) {
      const dir = targetPoint.clone().sub(origin).setY(0).normalize().multiplyScalar(0.35);
      await this.tween(110, (t) => v.model.body.position.set(dir.x * easeOut(t), 0, dir.z * easeOut(t)));
      this.slash(targetPoint, v.model.root.rotation.y, ability.id === 'attack' ? 0xffffff : fx.core);
      if (ability.id !== 'attack') this.elementBurst(targetPoint, el, 8);
      await this.tween(150, (t) => v.model.body.position.set(dir.x * (1 - t), 0, dir.z * (1 - t)));
      return;
    }
    if (ability.effects.some((e) => e.kind === 'dash' || e.kind === 'teleport' || e.kind === 'swap')) {
      this.elementBurst(origin, el, 8);
      return;
    }

    // Ranged / spell: projectile, then impact rings and elemental particles over the area.
    const support = ability.affects === 'allies';
    await this.tween(140, (t) => (v.model.body.position.y = Math.sin(t * Math.PI) * 0.08));
    const arrow = hero.heroClass === 'ranger' && ability.area.kind === 'single';
    if (ability.area.kind === 'line') {
      const end = this.standPoint(ev.area[ev.area.length - 1] ?? ev.target).add(new THREE.Vector3(0, 0.45, 0));
      await this.projectileFx(origin, end, el, 0, false);
      for (const p of ev.area) this.elementBurst(ground(p).add(new THREE.Vector3(0, 0.3, 0)), el, 5);
      return;
    }
    if (!support) await this.projectileFx(origin, targetPoint, el, hero.heroClass === 'ranger' ? 0.6 : 0.3, arrow);
    if (ability.area.kind !== 'single') {
      for (const p of ev.area) {
        this.impactRing(ground(p), support ? 0x7fe0a6 : fx.glow, 0.8);
        this.elementBurst(ground(p).add(new THREE.Vector3(0, 0.25, 0)), support ? 'nature' : el, 5);
      }
      this.shake = support ? 0 : 0.08;
    } else {
      this.impactRing(ground(ev.target), support ? 0x7fe0a6 : fx.glow, 0.8);
      this.elementBurst(targetPoint, support ? 'light' : el, support ? 8 : 10);
    }
  }

  private async animateDamage(unitId: string, amount: number, absorbed: number, tags: DamageTag[]) {
    const v = this.units.get(unitId);
    if (!v) return;
    v.shield = Math.max(0, v.shield - absorbed);
    v.hp = Math.max(0, v.hp - (amount - absorbed));
    this.renderTag(v);
    this.flash(v, tags.includes('burn') ? 0xffa040 : 0xffffff);
    const label = tags.filter((t) => t !== 'burn').map((t) => TAG_LABEL[t]);
    this.floater(unitId, `−${amount}`, `dmg${amount >= 12 ? ' big' : ''}`);
    if (label.length) this.floater(unitId, label.join(' · '), 'tags', 90);
    this.burst(v.model.root.position.clone().add(new THREE.Vector3(0, 0.45, 0)), tags.includes('burn') ? 0xff8a3d : 0xffe0c0, 8);
    this.shake = Math.max(this.shake, Math.min(0.14, amount / 90));
    const base = v.model.root.position.clone();
    await this.tween(180, (t) => {
      v.model.body.position.x = Math.sin(t * Math.PI * 4) * 0.05 * (1 - t);
    });
    v.model.root.position.copy(base);
  }

  private async animateDeath(unitId: string) {
    const v = this.units.get(unitId);
    if (!v) return;
    v.alive = false;
    v.tag.remove();
    this.floater(v.model.root.position.clone().add(new THREE.Vector3(0, 1, 0)), 'Derrotado', 'debuff');
    const y0 = v.model.root.position.y;
    await this.tween(520, (t) => {
      v.model.body.rotation.x = -easeOut(t) * (Math.PI / 2);
      v.model.root.position.y = y0 - Math.max(0, t - 0.5) * 0.6;
      v.model.ring.scale.setScalar(1 - t);
    });
    this.scene.remove(v.model.root);
    if (this.activeId === unitId) this.marker.visible = false;
  }
}

export const STATUS_GLYPH: Record<StatusKind, string> = {
  stun: '✷',
  root: '⌘',
  burn: '♨',
  mark: '◎',
  weak: '↓',
  empower: '↑',
  guard: '⛨',
};

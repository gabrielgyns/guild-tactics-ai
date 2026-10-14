import * as THREE from 'three';
import { posKey, samePos, terrainAt } from '../domain/board';
import { findAbility, getHero } from '../domain/heroes';
import type { BattleEvent, BattleState, Board, DamageTag, Pos, StatusKind, Unit } from '../domain/types';
import { buildHeroModel, mat, type HeroModel } from './models';
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
    sc.left = sc.bottom = -6;
    sc.right = sc.top = 6;
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

    const capGeo = new THREE.BoxGeometry(1 / 3, 0.1, 1 / 3);
    const caps = new THREE.InstancedMesh(capGeo, new THREE.MeshLambertMaterial(), W * H * 9);
    caps.receiveShadow = true;
    caps.castShadow = true;
    const baseGeo = new THREE.BoxGeometry(1, 1, 1);
    const bases = new THREE.InstancedMesh(baseGeo, new THREE.MeshLambertMaterial(), W * H);
    bases.receiveShadow = true;
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
        const baseTop = t === 'water' ? -0.4 : top - 0.1;
        const baseH = baseTop + 0.5;
        m4.makeScale(0.995, baseH, 0.995).setPosition(c.x, -0.5 + baseH / 2, c.z);
        bases.setMatrixAt(y * W + x, m4);
        bases.setColorAt(y * W + x, color.set(t === 'hill' ? 0x8a6a46 : 0x6e5338));

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
    this.boardGroup.add(caps, bases);
    this.resize();
  }

  private addTrees(c: THREE.Vector3, rnd: () => number) {
    const spots = [
      [0.3, -0.3],
      [-0.32, 0.28],
    ];
    for (const [dx, dz] of spots) {
      const s = 0.8 + rnd() * 0.3;
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
    const model = buildHeroModel(u.heroId, u.side);
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
    const halfH = Math.max(4.1, 5.0 / aspect);
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

  private async projectile(from: THREE.Vector3, to: THREE.Vector3, color: number, arc: number, size = 0.12) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial({ color }));
    this.fxGroup.add(m);
    const dist = from.distanceTo(to);
    await this.tween(140 + dist * 60, (t) => {
      m.position.lerpVectors(from, to, t);
      m.position.y += Math.sin(t * Math.PI) * arc;
      m.rotation.set(t * 8, t * 6, 0);
    });
    this.fxGroup.remove(m);
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

  private async animateAbility(ev: Extract<BattleEvent, { type: 'abilityUsed' }>, state: BattleState) {
    const caster = state.units.find((u) => u.id === ev.unitId);
    const v = this.units.get(ev.unitId);
    if (!caster || !v) return;
    const ability = findAbility(caster.heroId, ev.abilityId);
    const hero = getHero(caster.heroId);
    const selfCast = ability.target === 'self' || samePos(ev.target, v.pos);
    if (!selfCast) this.face(v, ev.target);

    const origin = v.model.root.position.clone().add(new THREE.Vector3(0, 0.55, 0));
    const targetPoint = this.standPoint(ev.target).add(new THREE.Vector3(0, 0.45, 0));
    const fxColor = hero.palette.accent;
    if (ability.ultimate) {
      this.shake = 0.12;
      this.burst(origin, 0xffd166, 22, true);
      await this.tween(380, (t) => {
        v.model.body.position.y = Math.sin(t * Math.PI) * 0.4;
        v.model.body.rotation.y = t * Math.PI * 2;
      });
      v.model.body.rotation.y = 0;
    }

    if (selfCast) {
      await this.tween(260, (t) => (v.model.body.position.y = Math.sin(t * Math.PI) * 0.18));
      this.burst(origin, fxColor, 12, true);
      if (ability.area.kind !== 'single') {
        for (const p of ev.area) this.burst(this.standPoint(p).add(new THREE.Vector3(0, 0.1, 0)), fxColor, 4, true);
      }
      return this.wait(120);
    }

    const melee = ability.range.max <= 1 && ability.target === 'enemy' && !ability.effects.some((e) => e.kind === 'dash');
    if (melee) {
      const dir = targetPoint.clone().sub(origin).setY(0).normalize().multiplyScalar(0.35);
      await this.tween(120, (t) => v.model.body.position.set(dir.x * easeOut(t), 0, dir.z * easeOut(t)));
      await this.tween(140, (t) => v.model.body.position.set(dir.x * (1 - t), 0, dir.z * (1 - t)));
      return;
    }
    if (ability.effects.some((e) => e.kind === 'dash' || e.kind === 'teleport' || e.kind === 'swap')) return;

    // Ranged / spell: projectile, then a burst over the area.
    const support = hero.heroClass === 'support' && ability.affects === 'allies';
    await this.tween(140, (t) => (v.model.body.position.y = Math.sin(t * Math.PI) * 0.08));
    const arc = hero.heroClass === 'ranger' ? 0.6 : 0.25;
    if (ability.area.kind === 'line') {
      const end = this.standPoint(ev.area[ev.area.length - 1] ?? ev.target).add(new THREE.Vector3(0, 0.45, 0));
      await this.projectile(origin, end, fxColor, 0, 0.16);
    } else if (!support) {
      await this.projectile(origin, targetPoint, hero.heroClass === 'ranger' ? 0xe8dcc0 : fxColor, arc);
    }
    if (ability.area.kind !== 'single') {
      for (const p of ev.area) this.burst(this.standPoint(p).add(new THREE.Vector3(0, 0.15, 0)), fxColor, 5, support);
      this.shake = support ? 0 : 0.08;
    } else if (support) {
      this.burst(targetPoint, fxColor, 10, true);
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

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CUE_SPECS, DRAG_SHOOT_CONFIG } from '../game/utils/constants';
import { disposeObject3D } from '../game/utils/dispose';
import { createCueButtTexture } from '../game/utils/ProceduralTextures';
import { soundEngine } from '../game/utils/SoundEngine';
import { canLocalPlayerAct, useGameStore } from '../store/useGameStore';

interface MiniatureCueControllerProps {
  onShoot: (power: number) => void;
}

export function computePowerFromDragPx(dragPx: number): number {
  const { minDragPx, maxDragPx, powerExponent } = DRAG_SHOOT_CONFIG;
  if (dragPx < minDragPx) return 0;
  const clamped = Math.min(maxDragPx, dragPx);
  const norm = (clamped - minDragPx) / (maxDragPx - minDragPx);
  return Math.min(1, Math.max(0.04, Math.pow(norm, powerExponent)));
}

export function MiniatureCueController({ onShoot }: MiniatureCueControllerProps) {
  const ballsMoving = useGameStore((s) => s.ballsMoving);
  const isShotAnimating = useGameStore((s) => s.isShotAnimating);
  const matchPhase = useGameStore((s) => s.matchPhase);
  const isAiThinking = useGameStore((s) => s.isAiThinking);
  const cueAngle = useGameStore((s) => s.cueAngle);
  const setDragState = useGameStore((s) => s.setDragState);
  const canAct = useGameStore(canLocalPlayerAct);

  const disabled =
    ballsMoving ||
    isShotAnimating ||
    isAiThinking ||
    !canAct ||
    matchPhase === 'BALL_IN_HAND' ||
    matchPhase === 'BALLS_MOVING' ||
    matchPhase === 'GAME_OVER';

  const [displayPower, setDisplayPower] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const activePointerRef = useRef<{ id: number; startY: number; lastPower: number } | null>(null);

  const animStateRef = useRef({
    targetPull: 0,
    currentPull: 0,
    cueAngle: 0,
    needsRender: true,
    strikeFlash: 0,
  });

  useEffect(() => {
    animStateRef.current.cueAngle = cueAngle;
    animStateRef.current.needsRender = true;
  }, [cueAngle]);

  // Mount isolated frameless miniature 3D cue stick WebGL scene
  useEffect(() => {
    const container = canvasWrapRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let frameId = 0;
    let disposed = false;

    try {
      const width = Math.max(48, container.clientWidth);
      const height = Math.max(140, container.clientHeight);

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'default',
      });
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.18;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      container.appendChild(renderer.domElement);

      scene = new THREE.Scene();

      const camera = new THREE.PerspectiveCamera(28, width / height, 0.05, 10);
      camera.position.set(0, 0.02, 1.38);
      camera.lookAt(0, -0.02, 0);

      // Studio lighting matching table cue materials
      const hemi = new THREE.HemisphereLight(0xd4e6ff, 0x261c14, 1.25);
      scene.add(hemi);

      const key = new THREE.DirectionalLight(0xfff1d6, 2.35);
      key.position.set(1.2, 1.8, 2.2);
      scene.add(key);

      const rim = new THREE.DirectionalLight(0x93c5fd, 1.0);
      rim.position.set(-1.4, -0.5, 1.0);
      scene.add(rim);

      // Realistic 3D Miniature Cue Stick ONLY (no box, no frame, no extra sphere)
      const stickGroup = new THREE.Group();
      const maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      const buttTex = createCueButtTexture(maxAniso);

      const tipMat = new THREE.MeshStandardMaterial({ color: 0x1b5299, roughness: 0.88 });
      const ferruleMat = new THREE.MeshPhysicalMaterial({
        color: 0xf7f4eb,
        roughness: 0.18,
        clearcoat: 0.65,
      });
      const mapleMat = new THREE.MeshPhysicalMaterial({
        color: 0xe3c291,
        roughness: 0.25,
        clearcoat: 0.6,
      });
      const brassMat = new THREE.MeshPhysicalMaterial({
        color: 0xd9b35c,
        metalness: 0.94,
        roughness: 0.18,
      });
      const buttMat = new THREE.MeshPhysicalMaterial({
        map: buttTex,
        roughness: 0.22,
        clearcoat: 0.85,
      });
      const rubberMat = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.85 });

      const s = 0.41;
      const tipGeo = new THREE.CylinderGeometry(
        CUE_SPECS.tipRadius * 1.55,
        CUE_SPECS.tipRadius * 1.75,
        0.013,
        24,
      );
      const tipMesh = new THREE.Mesh(tipGeo, tipMat);
      tipMesh.position.y = -0.0065;
      stickGroup.add(tipMesh);

      const ferruleGeo = new THREE.CylinderGeometry(
        CUE_SPECS.tipRadius * 1.75,
        CUE_SPECS.tipRadius * 1.84,
        0.024,
        24,
      );
      const ferruleMesh = new THREE.Mesh(ferruleGeo, ferruleMat);
      ferruleMesh.position.y = -0.025;
      stickGroup.add(ferruleMesh);

      const shaftPts = [
        new THREE.Vector2(CUE_SPECS.tipRadius * 1.84, 0),
        new THREE.Vector2(0.0165, 0.24 * s),
        new THREE.Vector2(0.020, 0.68 * s),
      ];
      const shaftGeo = new THREE.LatheGeometry(shaftPts, 24);
      shaftGeo.rotateZ(Math.PI);
      const shaftMesh = new THREE.Mesh(shaftGeo, mapleMat);
      shaftMesh.position.y = -0.037;
      stickGroup.add(shaftMesh);

      const jointGeo = new THREE.CylinderGeometry(0.0205, 0.021, 0.022, 24);
      const jointMesh = new THREE.Mesh(jointGeo, brassMat);
      jointMesh.position.y = -0.037 - 0.68 * s - 0.011;
      stickGroup.add(jointMesh);

      const buttPts = [
        new THREE.Vector2(0.021, 0),
        new THREE.Vector2(0.0245, 0.34 * s),
        new THREE.Vector2(0.0275, 0.72 * s),
      ];
      const buttGeo = new THREE.LatheGeometry(buttPts, 28);
      buttGeo.rotateZ(Math.PI);
      const buttMesh = new THREE.Mesh(buttGeo, buttMat);
      buttMesh.position.y = -0.037 - 0.68 * s - 0.022;
      stickGroup.add(buttMesh);

      const bumperGeo = new THREE.CylinderGeometry(0.0265, 0.023, 0.016, 20);
      const bumperMesh = new THREE.Mesh(bumperGeo, rubberMat);
      bumperMesh.position.y = -0.037 - 0.68 * s - 0.022 - 0.72 * s - 0.008;
      stickGroup.add(bumperMesh);

      const idleTipY = 0.295;
      stickGroup.position.set(0, idleTipY, 0);
      stickGroup.rotation.x = 0.05;
      scene.add(stickGroup);

      let lastTime = performance.now();

      const loop = (now: number) => {
        if (disposed || !renderer || !scene) return;
        const dt = Math.min(0.05, (now - lastTime) / 1000);
        lastTime = now;

        const st = animStateRef.current;

        if (st.strikeFlash > 0) {
          st.strikeFlash = Math.max(0, st.strikeFlash - dt * 6.5);
          st.needsRender = true;
        }

        const prevPull = st.currentPull;
        if (activePointerRef.current) {
          st.currentPull = st.targetPull;
        } else {
          st.currentPull = THREE.MathUtils.damp(st.currentPull, st.targetPull, 16, dt);
          if (Math.abs(st.currentPull - st.targetPull) < 0.001) {
            st.currentPull = st.targetPull;
          } else {
            st.needsRender = true;
          }
        }

        if (Math.abs(prevPull - st.currentPull) > 0.0005) {
          st.needsRender = true;
        }

        if (st.needsRender) {
          const strikeLift = Math.sin(st.strikeFlash * Math.PI) * 0.042;
          stickGroup.position.y = idleTipY - st.currentPull * 0.21 + strikeLift;
          stickGroup.rotation.y = st.cueAngle;
          renderer.render(scene, camera);
          st.needsRender = false;
        }

        frameId = requestAnimationFrame(loop);
      };

      frameId = requestAnimationFrame(loop);

      let lastW = width;
      let lastH = height;
      let resizeRafId = 0;

      const onResize = () => {
        if (disposed || !renderer || !container) return;
        if (resizeRafId) cancelAnimationFrame(resizeRafId);
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          if (disposed || !renderer || !container) return;
          const w = Math.max(48, container.clientWidth);
          const h = Math.max(140, container.clientHeight);
          if (w === lastW && h === lastH) return;
          lastW = w;
          lastH = h;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h, false);
          animStateRef.current.needsRender = true;
        });
      };
      const ro = new ResizeObserver(onResize);
      ro.observe(container);

      return () => {
        disposed = true;
        cancelAnimationFrame(frameId);
        cancelAnimationFrame(resizeRafId);
        ro.disconnect();
        if (scene) disposeObject3D(scene);
        if (renderer) {
          renderer.dispose();
          if (renderer.domElement.parentElement === container) {
            container.removeChild(renderer.domElement);
          }
        }
      };
    } catch {
      return () => {
        disposed = true;
        cancelAnimationFrame(frameId);
      };
    }
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || (e.button !== 0 && e.pointerType === 'mouse')) return;
    e.preventDefault();
    e.stopPropagation();

    soundEngine.unlock();

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore
    }

    activePointerRef.current = {
      id: e.pointerId,
      startY: e.clientY,
      lastPower: 0,
    };

    setIsDragging(true);
    setDisplayPower(0);
    setDragState(true, 0);
    animStateRef.current.targetPull = 0;
    animStateRef.current.needsRender = true;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const active = activePointerRef.current;
    if (!active || active.id !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const rawDragPx = Math.max(0, e.clientY - active.startY);
    const clampedPx = Math.min(DRAG_SHOOT_CONFIG.maxDragPx, rawDragPx);
    const power = computePowerFromDragPx(clampedPx);
    const visualNorm = clampedPx / DRAG_SHOOT_CONFIG.maxDragPx;

    active.lastPower = power;
    setDisplayPower(Math.round(power * 100));
    setDragState(true, power);

    animStateRef.current.targetPull = visualNorm;
    animStateRef.current.needsRender = true;
  };

  const finishDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    shouldShoot: boolean,
  ) => {
    const active = activePointerRef.current;
    if (!active || active.id !== e.pointerId) return;
    e.preventDefault();

    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }

    const finalPower = active.lastPower;
    activePointerRef.current = null;

    setIsDragging(false);
    setDisplayPower(0);
    setDragState(false, 0);

    animStateRef.current.targetPull = 0;
    animStateRef.current.needsRender = true;

    if (shouldShoot && finalPower > 0 && !disabled) {
      animStateRef.current.strikeFlash = 1;
      onShoot(finalPower);
    }
  };

  return (
    <div
      className="pointer-events-auto relative flex flex-col items-center select-none"
      style={{ touchAction: 'none' }}
    >
      {/* Tiny, unobtrusive floating power indicator (visible when dragging/charging) */}
      <div className="mb-1 h-4 flex items-center justify-center">
        {(isDragging || displayPower > 0) && (
          <span
            className="text-[11px] font-mono font-extrabold tabular-nums text-amber-400"
            style={{ textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}
          >
            {displayPower}%
          </span>
        )}
      </div>

      {/* Frameless floating 3D miniature cue stick interaction zone (no border, no box, no background panel) */}
      <div
        role="slider"
        aria-label="Drag miniature cue stick back and release to shoot"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displayPower}
        aria-disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => {
          e.stopPropagation();
          finishDrag(e, true);
        }}
        onPointerCancel={(e) => {
          e.stopPropagation();
          finishDrag(e, false);
        }}
        className={`relative h-[168px] w-[54px] sm:h-[224px] sm:w-[66px] transition-opacity ${
          disabled
            ? 'opacity-40 cursor-not-allowed'
            : isDragging
              ? 'opacity-100 cursor-grabbing'
              : 'opacity-95 hover:opacity-100 cursor-grab'
        }`}
        style={{
          touchAction: 'none',
          filter: 'drop-shadow(0 6px 14px rgba(0, 0, 0, 0.72))',
        }}
      >
        <div ref={canvasWrapRef} className="pointer-events-none h-full w-full" />
      </div>
    </div>
  );
}

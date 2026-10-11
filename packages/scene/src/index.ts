export { VoxelEngine, EngineError, snapshotBounds } from './engine.ts';
export type { EngineResult, EngineSerialized, Voxel, Change } from './engine.ts';
export { createInitialScene } from './initialScene.ts';
export { createPrefabGeometry, prefabOperations } from './prefabs.ts';
export { cellKey, cellCenter, boundsOf, rotateCell, chunkAddress } from './coordinates.ts';
export type { Vec3 } from './coordinates.ts';
export type { SceneSnapshot, SceneBatch, Group, Part, Operation, AiOperation } from '../../protocol/src/index.ts';

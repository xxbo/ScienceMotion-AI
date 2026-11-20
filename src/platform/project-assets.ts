import type { ProjectAsset, ProjectDocument, SceneNode } from "../contracts/project";
import { pcmWavInfo } from "./wav-input";

const kinds = new Set(["image", "video", "audio", "font", "model", "texture", "data", "other"]);

export function assertProjectAsset(asset: ProjectAsset): void {
  if (!asset || typeof asset.id !== "string" || !asset.id.trim() || asset.id.includes("\0") ||
      typeof asset.uri !== "string" || !asset.uri.trim() || !kinds.has(asset.kind)) {
    throw new Error("Invalid project asset");
  }
  for (const field of [asset.contentHash, asset.license, asset.attribution]) {
    if (field !== undefined && typeof field !== "string") throw new Error("Invalid asset metadata");
  }
  artifactIdForAsset(asset);
}

/** An external file with a hash is not automatically owned by the local artifact store. */
export function artifactIdForAsset(asset: Pick<ProjectAsset, "id" | "uri" | "contentHash">): string | undefined {
  if (typeof asset.uri !== "string") throw new Error("Invalid asset URI");
  if (!/^artifact:/i.test(asset.uri)) return undefined;
  const match = /^artifact:\/\/sha256\/([a-f0-9]{64})$/.exec(asset.uri);
  if (!match) throw new Error(`Invalid artifact URI for asset ${asset.id}`);
  if (asset.contentHash !== undefined && asset.contentHash !== match[1]) {
    throw new Error(`Artifact URI/hash conflict for asset ${asset.id}`);
  }
  return `sha256:${match[1]}`;
}

export function pngArtifactForAsset(asset: ProjectAsset | undefined): string | undefined {
  if (asset?.kind === "image" && asset.metadata?.mediaType === "image/png") return artifactIdForAsset(asset);
}

export function narrationAsset(asset: ProjectAsset | undefined) {
  if (asset?.kind !== "audio" || asset.metadata?.mediaType !== "audio/wav") return;
  const info = pcmWavInfo(asset.metadata), artifactId = artifactIdForAsset(asset);
  if (info && artifactId) return { ...info, artifactId };
}

export function projectImagePlacement(node: SceneNode) {
  if (node.type !== "image") return undefined;
  const image = node.components.find(component => component.kind === "image")?.data;
  const { assetId, width, height } = image ?? {};
  if (typeof assetId === "string" && assetId && typeof width === "number" && width > 0 && width <= 10000 &&
      typeof height === "number" && height > 0 && height <= 10000) return { assetId, width, height };
}

export function projectPngArtifactIds(project: ProjectDocument): string[] {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const ids = new Set<string>();
  for (const node of project.nodes) {
    const image = projectImagePlacement(node);
    const id = image && pngArtifactForAsset(assets.get(image.assetId));
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Component references use assetId/assetIds; custom references must declare dependency edges. */
export function projectAssetUses(project: ProjectDocument, assetId: string): string[] {
  const uses = (project.clips ?? []).filter((clip) => clip.assetId === assetId).map((clip) => `clip:${clip.id}`);
  for (const edge of project.dependencies) {
    if ((edge.fromType === "asset" && edge.fromId === assetId) || (edge.toType === "asset" && edge.toId === assetId)) uses.push(`dependency:${edge.id}`);
  }
  const contains = (value: unknown, seen = new Set<object>()): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((item) => contains(item, seen));
    const object = value as Record<string, unknown>;
    if (object.assetId === assetId || (Array.isArray(object.assetIds) && object.assetIds.includes(assetId))) return true;
    return Object.values(object).some((item) => contains(item, seen));
  };
  for (const node of project.nodes) {
    if (node.components.some((component) => contains(component.data))) uses.push(`node:${node.id}`);
  }
  return uses;
}

export function assertAssetRemovable(project: ProjectDocument, assetId: string): void {
  const uses = projectAssetUses(project, assetId);
  if (uses.length) throw new Error(`Asset is in use: ${assetId} (${uses.join(", ")})`);
}

export function projectArtifactBindings(project: ProjectDocument): Array<{ assetId: string; artifactId: string }> {
  const ids = new Set<string>();
  return project.assets.flatMap((asset) => {
    assertProjectAsset(asset);
    if (ids.has(asset.id)) throw new Error(`Duplicate asset ID: ${asset.id}`);
    ids.add(asset.id);
    const artifactId = artifactIdForAsset(asset);
    return artifactId ? [{ assetId: asset.id, artifactId }] : [];
  });
}

export function assertAssetReferences(project: ProjectDocument): void {
  const ids = new Set(project.assets.map((asset) => asset.id));
  const referenced = new Set((project.clips ?? []).map((clip) => clip.assetId));
  for (const edge of project.dependencies) {
    if (edge.fromType === "asset") referenced.add(edge.fromId);
    if (edge.toType === "asset") referenced.add(edge.toId);
  }
  const visit = (value: unknown, seen = new Set<object>()): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((item) => visit(item, seen)); return; }
    const object = value as Record<string, unknown>;
    if (typeof object.assetId === "string") referenced.add(object.assetId);
    if (Array.isArray(object.assetIds)) for (const id of object.assetIds) if (typeof id === "string") referenced.add(id);
    Object.values(object).forEach((item) => visit(item, seen));
  };
  for (const node of project.nodes) for (const component of node.components) visit(component.data);
  for (const id of referenced) if (!ids.has(id)) throw new Error(`Dangling project asset reference: ${id}`);
}

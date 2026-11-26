export declare function cleanAbandonedDevWorkspaces(parent: string): string[];
export declare function createRokuDevWorkspace(
  parent: string,
  options?: { label?: string; keep?: number },
): {
  directory: string;
  abandoned: string[];
  generation(number: number): string;
  publish(generation: number): void;
  dispose(): void;
};

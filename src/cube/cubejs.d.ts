declare module 'cubejs' {
  export default class Cube {
    constructor(other?: unknown);
    center: number[];
    cp: number[];
    co: number[];
    ep: number[];
    eo: number[];
    static fromString(str: string): Cube;
    static random(): Cube;
    static initSolver(): void;
    toJSON(): {
      center: number[];
      cp: number[];
      co: number[];
      ep: number[];
      eo: number[];
    };
    asString(): string;
    cornerParity(): number;
    edgeParity(): number;
    move(alg: string): this;
    isSolved(): boolean;
    solve(maxDepth?: number): string;
  }
}

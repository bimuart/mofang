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
  }
}

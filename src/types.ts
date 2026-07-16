export interface Note {
  _id: string;
  text: string;
  x: number;
  y: number;
  color?: string;
  fontFamily?: string;
  createdAt: string;
}

export interface Viewport {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

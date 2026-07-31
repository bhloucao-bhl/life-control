import { ImageResponse } from 'next/og';
export const size = { width: 192, height: 192 };
export const contentType = 'image/png';
export default function Icon() {
  return new ImageResponse(
    (<div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0B0B0F', color: '#F5C263', fontSize: 58, fontWeight: 800, letterSpacing: '-3px' }}>BhL</div>),
    { ...size }
  );
}

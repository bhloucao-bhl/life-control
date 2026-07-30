import { ImageResponse } from 'next/og';

export const size = { width: 192, height: 192 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{
        width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0B0B0F', color: '#E6B450', fontSize: 66, fontWeight: 700, letterSpacing: '-2px',
      }}>
        BhL
      </div>
    ),
    { ...size }
  );
}

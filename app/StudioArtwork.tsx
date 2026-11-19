import * as React from "react";
export default function StudioArtwork() {
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (name: string) => `sc-art-${uid}-${name}`;
  const paint = (name: string) => `url(#${id(name)})`;
  const plate =
    "M39 -89 Q40 -94 45 -92 L204 -19 Q213 -15 204 -10 L-10 113 Q-17 117 -15 108 Z";
  const face = (x: number, y: number) => (
    <g transform={`translate(${x} ${y})`}>
      {Array.from({ length: 17 }, (_, index) => {
        const depth = 16 - index;
        return (
          <use
            key={depth}
            href={`#${id("triangle")}`}
            transform={`translate(${-0.85 * depth} ${1.6 * depth})`}
            fill={paint("edge")}
            stroke={paint("ribs")}
            strokeWidth={1.15}
          />
        );
      })}
      <use
        href={`#${id("triangle")}`}
        fill={paint("metal")}
        stroke="#dfff85"
        strokeWidth="1.55"
      />
      <g clipPath={paint("plate-clip")}>
        <path
          d="M41 -93 L207 -17 L198 -14 L46 -82 L-7 101 L-16 114 Z"
          fill="#f5ffc1"
          opacity=".74"
        />
        <path d="M-16 114 L207 -15 L196 -16 L-6 99 Z" fill="#6d960c" />
        {Array.from({ length: 37 }, (_, index) => {
          const scale = 0.926 - index * 0.025;
          return (
            <use
              key={index}
              href={`#${id("triangle")}`}
              transform={`translate(78 2) scale(${scale}) translate(-78 -2)`}
              fill="none"
              stroke={paint("groove")}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        <rect
          x="-20"
          y="-95"
          width="236"
          height="220"
          fill={paint("brushed")}
          opacity=".17"
        />
      </g>
      <path
        d="M-14 107 L39 -88 Q41 -94 47 -91 L152 -43"
        fill="none"
        stroke="#f0ffba"
        opacity=".9"
        strokeWidth="1.7"
      />
    </g>
  );
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 360 640"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", pointerEvents: "none", overflow: "hidden" }}
    >
      <defs>
        <path id={id("triangle")} d={plate} />
        <clipPath id={id("plate-clip")}>
          <path d={plate} />
        </clipPath>
        <radialGradient id={id("ground")} cx="58%" cy="54%" r="74%">
          <stop offset="0" stopColor="#323e22" />
          <stop offset=".48" stopColor="#1b231a" />
          <stop offset="1" stopColor="#0c100e" />
        </radialGradient>
        <radialGradient id={id("bounce")}>
          <stop stopColor="#b1d245" stopOpacity=".26" />
          <stop offset="1" stopColor="#a7cd39" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id("metal")} x1="0%" x2="92%" y1="2%" y2="87%">
          <stop stopColor="#efffb9" />
          <stop offset=".2" stopColor="#ddff7b" />
          <stop offset=".49" stopColor="#c5f63e" />
          <stop offset=".7" stopColor="#acce38" />
          <stop offset=".88" stopColor="#d8fe75" />
          <stop offset="1" stopColor="#b5e543" />
        </linearGradient>
        <linearGradient id={id("ribs")} x1="0%" y1="20%" x2="92%" y2="80%">
          <stop stopColor="#649016" />
          <stop offset=".17" stopColor="#bedf55" />
          <stop offset=".46" stopColor="#617c25" />
          <stop offset=".81" stopColor="#97ba3b" />
          <stop offset="1" stopColor="#d4eb78" />
        </linearGradient>
        <linearGradient
          id={id("edge")}
          x1="0"
          x2="1"
          y1="0"
          y2=".2"
          gradientUnits="objectBoundingBox"
        >
          <stop stopColor="#38471a" />
          <stop offset=".32" stopColor="#657e26" />
          <stop offset=".6" stopColor="#344119" />
          <stop offset="1" stopColor="#879f32" />
        </linearGradient>
        <linearGradient id={id("groove")} x1="0%" y1="15%" x2="75%" y2="100%">
          <stop stopColor="#6d8a27" stopOpacity=".55" />
          <stop offset=".47" stopColor="#5d8015" stopOpacity=".13" />
          <stop offset="1" stopColor="#698717" stopOpacity=".72" />
        </linearGradient>
        <linearGradient id={id("grid-fade")} x1="0%" x2="0%" y1="0%" y2="100%">
          <stop stopColor="#fff" stopOpacity=".12" />
          <stop offset=".52" stopColor="#fff" stopOpacity=".7" />
          <stop offset="1" stopColor="#fff" />
        </linearGradient>
        <mask id={id("grid-mask")}>
          <rect width="360" height="640" fill={paint("grid-fade")} />
        </mask>
        <pattern
          id={id("brushed")}
          width="3"
          height="3"
          patternUnits="userSpaceOnUse"
        >
          <path d="M0 0h3" stroke="#f0ffc0" strokeWidth="1" />
        </pattern>
        <pattern
          id={id("grain")}
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1.3" cy="2.1" r=".46" fill="#c2cea2" opacity=".23" />
          <circle cx="3.9" cy="4.2" r=".42" fill="#000" opacity=".38" />
        </pattern>
      </defs>
      <rect width="360" height="640" fill={paint("ground")} />
      <g
        mask={paint("grid-mask")}
        stroke="#84966c"
        strokeWidth=".85"
        opacity=".35"
      >
        {Array.from({ length: 31 }, (_, i) => (
          <path key={i} d={`M${-1140 + i * 88} 680 L${180 + i * 7.5} -80`} />
        ))}
        {Array.from({ length: 25 }, (_, i) => {
          const y = -47 + i * 6.5 + i * i * 1.04;
          return <path key={i} d={`M-50 ${y + 41} L410 ${y - 45}`} />;
        })}
      </g>
      <g transform="translate(180 319) scale(.823) translate(-321 -279)">
        <ellipse
          cx="322"
          cy="363"
          rx="243"
          ry="61"
          fill={paint("bounce")}
          transform="rotate(-9 322 363)"
        />
        <g fill="none" stroke="#c4e683" opacity=".32">
          <path d="M58 320l60 -35m-38 41l36 -21M462 156l40 -23m-6 12l37 -21M400 370l62 -36" />
          <path d="M91 175l16 -9m382 103l15 -9m-230 128l14 -8" opacity=".6" />
        </g>
        <g transform="rotate(-4 320 275)">
          {face(133, 269)}
          {face(329, 248)}
        </g>
      </g>
      <rect width="360" height="640" fill={paint("grain")} />
      <g fill="none" stroke="#c1cc9d" strokeWidth="1" opacity=".57">
        <path d="M17 92v8m-4 -4h8M343 92v8m-4 -4h8M17 544v8m-4 -4h8M343 544v8m-4 -4h8" />
      </g>
    </svg>
  );
}

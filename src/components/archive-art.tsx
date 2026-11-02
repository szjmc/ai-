export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" role="img" aria-label="知栈标志">
      <rect width="40" height="40" rx="11" fill="#4c6ee8" />
      <path d="M10 12.5c3.8-1.2 7-.5 10 1.5 3-2 6.2-2.7 10-1.5v15c-3.8-1.2-7-.5-10 1.5-3-2-6.2-2.7-10-1.5zM20 14v15M13.5 17l3.5 1M23 18l3.5-1M13.5 21l3.5 1M23 22l3.5-1" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Embedded SVG: unlike a remote/uploaded picture, it has no deploy-time file path. */
export function ArchiveArt() {
  const books = [
    { x: 18, w: 23, y: 40, color: "#6b3b29" }, { x: 44, w: 17, y: 30, color: "#b48150" },
    { x: 64, w: 26, y: 49, color: "#9a5238" }, { x: 94, w: 16, y: 36, color: "#c1a077" },
    { x: 113, w: 30, y: 23, color: "#4d6150" }, { x: 148, w: 22, y: 43, color: "#b78754" },
    { x: 174, w: 28, y: 33, color: "#743e30" }, { x: 208, w: 18, y: 46, color: "#b39a75" },
    { x: 230, w: 24, y: 31, color: "#655143" },
  ];
  return (
    <svg className="archive-art" viewBox="0 0 272 250" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="272" height="250" fill="#302218" />
      <path d="M0 8h272M0 149h272M0 155h272M12 0v250M260 0v250" stroke="#8f633b" strokeWidth="5" />
      {books.map((book) => (
        <g key={book.x}>
          <rect x={book.x} y={book.y} width={book.w} height={145 - book.y} rx="2" fill={book.color} />
          <path d={`M${book.x + 3} ${book.y + 4}v${137 - book.y}M${book.x + 5} ${book.y + 14}h${book.w - 10}M${book.x + 5} 130h${book.w - 10}`} stroke="#ead4ac" strokeOpacity=".45" />
          <rect x={book.x + 6} y={book.y + 30} width={book.w - 12} height="24" rx="1" fill="#ead4ac" fillOpacity=".4" />
        </g>
      ))}
      <path d="M23 169h80v16H23zM22 190h87v13H22zM126 168v80h24v-80zM156 179v69h19v-69zM184 162v86h31v-86zM224 173v75h24v-75z" fill="#916640" opacity=".65" />
      <path d="M0 212h272v38H0z" fill="#21170f" opacity=".75" />
    </svg>
  );
}

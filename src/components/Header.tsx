"use client";

interface HeaderProps {
  dateStr: string;
}

export default function Header({ dateStr }: HeaderProps) {
  return (
    <header
      className="flex items-center justify-between px-4 py-3 bg-background border-b border-black/10 shrink-0"
      style={{ zIndex: 100 }}
    >
      <span className="font-mono text-xs uppercase tracking-wider text-[#000]">
        {dateStr}
      </span>
    </header>
  );
}

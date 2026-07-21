import { useState } from "react";
import { Link } from "react-router-dom";

export default function CustomHeader() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <header className="bg-gray-900 text-white p-4 flex items-center justify-between">
      <div className="flex items-center space-x-4">
        <img src="/logo.png" alt="Logo" className="h-8" />
        <h1 className="text-xl font-semibold">Cardinal Frame</h1>
      </div>
      <button
        onClick={() => setSidebarOpen(v => !v)}
        className="hidden md:hidden text-white"
        aria-label="Toggle menu"
      >
        <svg
          className="h-6 w-6"
          fill="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>
      <nav className="hidden md:flex space-x-6">
        <Link to="/" className="hover:underline">Home</Link>
        <Link to="/dashboard" className="hover:underline">Dashboard</Link>
      </nav>
    </header>
  );
}
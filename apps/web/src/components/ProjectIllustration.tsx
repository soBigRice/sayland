/** Template artwork, deliberately not presented as a preview of a saved project. */
export function ProjectIllustration({ template }: { template: 'empty' | 'island' }) {
  return <svg viewBox="0 0 300 170" aria-hidden="true" focusable="false" className="project-illustration">
    <g fill="#fff" opacity=".9"><path d="M31 43c-5-14 16-20 22-8 12-7 25 2 21 12H30z" /><path d="M221 29c-3-11 14-18 20-6 11-5 21 3 18 11h-39z" /></g>
    {template === 'island' ? <>
      <ellipse cx="151" cy="139" rx="114" ry="22" fill="#b8e3e7" />
      <path d="m62 103 60-27 110 30-17 29-85 13-60-20z" fill="#d5a272" stroke="#b58766" strokeWidth="2" strokeLinejoin="round" />
      <path d="m61 101 61-26 111 27-45 27-65 6-54-15z" fill="#b9d582" stroke="#88ad64" strokeWidth="2" strokeLinejoin="round" />
      <path d="m123 124 27-8 27 4 13 5-18 5-33-1z" fill="#f6e6b4" />
      <path d="M155 105V68l38-3v38l-21 9z" fill="#ffecb6" stroke="#b69a73" strokeWidth="2" />
      <path d="m171 47 29 24-56 6z" fill="#ef9a79" stroke="#c67459" strokeWidth="2" strokeLinejoin="round" />
      <path d="M169 109V89l11-1v20" fill="#b18561" /><path d="m184 79 8-1v10l-8 1z" fill="#b6dce8" />
      <path d="M98 111V72M118 105V58" stroke="#a38459" strokeWidth="6" strokeLinecap="round" />
      <path d="m98 47-23 37q23 14 44-1z" fill="#80b78a" stroke="#639474" strokeWidth="2" strokeLinejoin="round" />
      <path d="m118 34-21 37q19 15 43-1z" fill="#a3c67a" stroke="#7ba45d" strokeWidth="2" strokeLinejoin="round" />
      <g fill="#fff5c9"><circle cx="98" cy="122" r="2.5" /><circle cx="207" cy="117" r="2.5" /></g>
      <path d="m219 146 14-2m-174-8 11 2" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </> : <>
      <ellipse cx="151" cy="140" rx="91" ry="13" fill="#ddd5eb" />
      <path d="m69 125 76-40 86 42-77 31z" fill="#f9f5fc" stroke="#c6b4d9" strokeWidth="2" strokeDasharray="5 6" strokeLinejoin="round" />
      <g stroke="#b49aca" strokeWidth="2" strokeLinejoin="round"><path d="m127 83 27-15 27 15-27 15z" fill="#f3e7fa" /><path d="m127 83 27 15v31l-27-15z" fill="#d4b9e8" /><path d="m154 98 27-15v31l-27 15z" fill="#bda3d6" /></g>
      <path d="m105 58 8-17 6 17 17 5-17 7-6 15-7-15-15-7z" fill="#ffe4a0" stroke="#ddc283" strokeWidth="2" strokeLinejoin="round" />
      <path d="m194 57 5-9 4 9 10 4-10 4-4 9-5-9-9-4z" fill="#f6be9c" />
      <g fill="#cbb5db"><circle cx="87" cy="99" r="3" /><circle cx="206" cy="100" r="3" /></g>
    </>}
  </svg>;
}

// src/components/Highlight.jsx
import { splitHighlight } from '../lib/vatTuSearch'

export default function Highlight({ text, query }) {
  const { before, match, after } = splitHighlight(text, query)
  if (!match) return text
  return <>{before}<mark style={{ background: '#FEF08A', color: 'inherit', borderRadius: 2 }}>{match}</mark>{after}</>
}

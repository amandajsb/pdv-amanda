export function normalizarTextoBusca(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '')
    .trim().replace(/\s+/gu, ' ').toLowerCase();
}

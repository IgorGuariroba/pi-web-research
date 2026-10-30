/** Mensagem legível de um erro qualquer (Error → message; resto → String). */
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

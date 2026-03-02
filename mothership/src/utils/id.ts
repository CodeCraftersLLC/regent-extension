import { nanoid } from 'nanoid';

export const newId = (size = 21) => nanoid(size);

import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "@oh-my-pi/hashline";

export { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER };

export const ADD_FILE_MARKER = "*** Add File:";

export const DELETE_FILE_MARKER = "*** Delete File:";

export const UPDATE_FILE_MARKER = "*** Update File:";

export const MOVE_TO_MARKER = "*** Move to:";

export const EOF_MARKER = "*** End of File";

export const FILE_OP_MARKERS = [UPDATE_FILE_MARKER, ADD_FILE_MARKER, DELETE_FILE_MARKER] as const;

export const PATCH_WRAPPER_MARKERS = [BEGIN_PATCH_MARKER, END_PATCH_MARKER] as const;

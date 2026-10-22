import { KeyboardSensor, MouseSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

/** Input policy only: every layout shares the same reorder/persistence flow.
 *  No touch sensor: on a touch screen a long press belongs to the row menu, so
 *  reordering takes a mouse or trackpad (iPad included) or the keyboard. */
export function useListSortSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

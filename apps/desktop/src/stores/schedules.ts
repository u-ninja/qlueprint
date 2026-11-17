import { create } from 'zustand';
import { commands, type Schedule_Serialize as Schedule, type ScheduleInput_Deserialize as ScheduleInput } from '@/bindings';
import { errorMessage } from '@/stores/connections';

type SchedulesState = {
    list: Schedule[];
    /** The last action's failure, until the next one */
    error: string | null;
    load: () => Promise<void>;
    /** False when it failed; `error` says why */
    save: (input: ScheduleInput) => Promise<boolean>;
    remove: (id: string) => Promise<void>;
    runNow: (id: string) => Promise<void>;
};

/** Runs the action, then reloads the list; a failure goes to `error` */
export const useSchedules = create<SchedulesState>()((set, get) => {
    const act = async (action: () => Promise<unknown>) => {
        try {
            await action();
            set({ error: null });
            await get().load();
            return true;
        } catch (error) {
            set({ error: errorMessage(error) });
            return false;
        }
    };
    return {
        list: [],
        error: null,
        load: async () => {
            try {
                set({ list: await commands.listSchedules() });
            } catch (error) {
                set({ error: errorMessage(error) });
            }
        },
        save: (input) => act(() => commands.saveSchedule(input)),
        remove: async (id) => void (await act(() => commands.deleteSchedule(id))),
        runNow: async (id) => void (await act(() => commands.runScheduleNow(id))),
    };
});

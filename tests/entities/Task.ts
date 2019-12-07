import {BaseEntity} from "../../src/BaseEntity";
import {Column} from "../../src/decorators/Column";
import {Entity} from "../../src/decorators/Entity";
// @ts-ignore
import {TaskGroup} from "./TaskGroup";

@Entity({namespace: "testing", kind: "task", ancestors: TaskGroup})
export class Task extends BaseEntity {
    @Column()
    public id: number = 0;

    @Column()
    public total: number = 0;
}
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type ModelSelectProps = {
  models: string[]
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
}

export function ModelSelect({
  models,
  value,
  onValueChange,
  disabled,
  className,
}: ModelSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled || models.length === 0}
    >
      <SelectTrigger className={className ?? "w-full sm:w-44"}>
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {models.map((model) => (
            <SelectItem key={model} value={model}>
              {model}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export const defaultPose = (ref) => {
    
    // Safety checks for the new R3F animRef structure
    if (ref.characters) ref.characters.push(' ')
    if (!ref.animations) ref.animations = []
    
    let animations = []
    
    animations.push(["mixamorigNeck", "rotation", "x", Math.PI/12, "+"]);
    animations.push(["mixamorigLeftArm", "rotation", "z", -Math.PI/3, "-"]);
    animations.push(["mixamorigLeftForeArm", "rotation", "y", -Math.PI/1.5, "-"]);
    animations.push(["mixamorigRightArm", "rotation", "z", Math.PI/3, "+"]);
    animations.push(["mixamorigRightForeArm", "rotation", "y", Math.PI/1.5, "+"]);
    
    ref.animations.push(animations);

    // Old imperative trigger: no longer used in R3F useFrame
    if(ref.pending !== undefined && ref.pending === false){
      ref.pending = true;
      if (ref.animate) ref.animate();
    }
}